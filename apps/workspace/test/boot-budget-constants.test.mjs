// apps/workspace/test/boot-budget-constants.test.mjs
//
// D#37 WS-D3 (Correction C26): the boot budget lives in build/budget.mjs and
// is imported, not repeated; the per-app ceiling (at most maxFilesPerApp boot
// files per first-party app, at most maxSharedLibFiles under apps/_lib/) is
// enforced on the real build and bites on a scratch app tree that breaks it.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { BOOT_BUDGET, perAppCeilingViolations } from "../build/budget.mjs";
import { build } from "../build/build.mjs";
import { loadFirstPartyApps } from "../build/first-party.mjs";
import { loadProfile } from "../build/profile.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = join(TEST_DIR, "..");
const REAL_PROFILE_PATH = join(WORKSPACE_DIR, "profiles", "cloud.json");
const REAL_APPS_DIR = join(WORKSPACE_DIR, "apps");

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// The first-party app ids a profile ships: the apps/ directories it lists.
function firstPartyIds(appsDir, profile) {
  return loadFirstPartyApps(appsDir)
    .apps.map((a) => a.id)
    .filter((id) => profile.app_modules.includes(id));
}

// A scratch apps tree plus a profile that also lists the app "demo". The
// entry statically imports every other file, so all of them are reachable at
// boot: `appFiles` counts main.js too, `libFiles` counts files under _lib/.
function scratchBuild({ appFiles, libFiles }) {
  const appsDir = scratchDir("ws-d3-apps-");
  const put = (rel, content) => {
    const dest = join(appsDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  };
  const imports = [];
  put("demo/manifest.json", JSON.stringify({ id: "demo", entry: "main.js" }));
  for (let i = 1; i < appFiles; i++) {
    put(`demo/f${i}.js`, "export {};\n");
    imports.push(`import "./f${i}.js";`);
  }
  for (let i = 0; i < libFiles; i++) {
    put(`_lib/l${i}.js`, "export {};\n");
    imports.push(`import "../_lib/l${i}.js";`);
  }
  put("demo/main.js", imports.join("\n") + "\nexport {};\n");

  const profile = JSON.parse(readFileSync(REAL_PROFILE_PATH, "utf8"));
  profile.app_modules = [...profile.app_modules, "demo"];
  const profilePath = join(scratchDir("ws-d3-profile-"), "profile.json");
  writeFileSync(profilePath, JSON.stringify(profile));

  const result = build({ profilePath, appsDir, outDir: join(scratchDir("ws-d3-out-"), "dist") });
  return { result, ids: firstPartyIds(appsDir, profile) };
}

const under = (result, dir) => result.bootFiles.filter((f) => f.startsWith(dir));

describe("D#37 WS-D3 criterion 1: one definition", () => {
  it("exports the C26 budget", () => {
    expect(BOOT_BUDGET).toEqual({
      maxStaticRequests: 130,
      maxBrotliBytes: 448 * 1024,
      maxFilesPerApp: 5,
      maxSharedLibFiles: 4,
    });
    expect(Object.isFrozen(BOOT_BUDGET)).toBe(true);
  });

  it("is imported by both budget assertions, which hold no literal cap of their own", () => {
    const profileTest = readFileSync(join(TEST_DIR, "profile.test.mjs"), "utf8");
    const bootSpec = readFileSync(join(WORKSPACE_DIR, "e2e", "boot-budget.spec.ts"), "utf8");
    for (const src of [profileTest, bootSpec]) {
      expect(src).toMatch(/from "\.\.\/build\/budget\.mjs"/);
      expect(src).toContain("BOOT_BUDGET.maxStaticRequests");
      expect(src).not.toMatch(/MAX_STATIC_REQUESTS *= *\d+|<= *90\b|toBeLessThanOrEqual\(90\)/);
    }
  });
});

describe("D#37 WS-D3 criterion 3: per-app ceiling", () => {
  it("the real profile passes", () => {
    const profile = loadProfile(REAL_PROFILE_PATH);
    const result = build({ profilePath: REAL_PROFILE_PATH, outDir: join(scratchDir("ws-d3-real-"), "dist") });
    const ids = firstPartyIds(REAL_APPS_DIR, profile);
    expect(ids).toContain("developer");
    expect(perAppCeilingViolations(result.bootFiles, ids)).toEqual([]);
  });

  it("an app at the ceiling (5 files) and a _lib at the ceiling (4 files) pass", () => {
    const { result, ids } = scratchBuild({
      appFiles: BOOT_BUDGET.maxFilesPerApp,
      libFiles: BOOT_BUDGET.maxSharedLibFiles,
    });
    expect(under(result, "apps/demo/")).toHaveLength(5);
    expect(under(result, "apps/_lib/")).toHaveLength(4);
    expect(perAppCeilingViolations(result.bootFiles, ids)).toEqual([]);
  });

  it("an app with 6 boot files fails, naming the app", () => {
    const { result, ids } = scratchBuild({ appFiles: 6, libFiles: 0 });
    expect(under(result, "apps/demo/")).toHaveLength(6);
    const violations = perAppCeilingViolations(result.bootFiles, ids);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/apps\/demo\/ has 6 boot files/);
  });

  it("a _lib with 5 boot files fails, naming _lib", () => {
    const { result, ids } = scratchBuild({ appFiles: 1, libFiles: 5 });
    expect(under(result, "apps/_lib/")).toHaveLength(5);
    const violations = perAppCeilingViolations(result.bootFiles, ids);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/apps\/_lib\/ has 5 boot files/);
  });
});
