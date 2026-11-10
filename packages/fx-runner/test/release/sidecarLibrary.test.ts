import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2c-2b (security review): in the single executable the Playwright library is loaded from the sidecar folder ONLY. Node's own lookup also walks parent folders, NODE_PATH and
 * ~/.node_modules, so a copy planted there would run inside the server that holds the saved session. bin/sidecarLibrary.mjs checks the resolved file's real path; these tests run it in a real
 * child Node with NODE_PATH set, exactly the lookup that would find a planted copy.
 */
const root = mkdtempSync(path.join(tmpRoot(), "sidecar-lib-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const library = (dir: string, marker: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "playwright-core", version: "0.0.0", main: "index.js" }));
  writeFileSync(path.join(dir, "index.js"), `module.exports = { marker: ${JSON.stringify(marker)} };\n`);
};
const probe = path.join(root, "probe.mjs");
writeFileSync(
  probe,
  `import { sidecarLibrary } from ${JSON.stringify(pathToFileURL(path.join(PACKAGE_DIR, "bin", "sidecarLibrary.mjs")).href)};
const lib = sidecarLibrary(process.argv[2]);
let loaded;
try { loaded = (await lib.load()).marker; } catch (e) { loaded = "ERR:" + e.message; }
console.log(JSON.stringify({ available: lib.available(), loaded }));
`,
);
const PLANT = path.join(root, "plant");
library(path.join(PLANT, "playwright-core"), "planted");
const run = (sidecar: string, env: Record<string, string> = {}): { available: boolean; loaded: string } =>
  JSON.parse(execFileSync(process.execPath, [probe, sidecar], { env: { PATH: process.env.PATH ?? "", HOME: path.join(root, "nohome"), ...env }, encoding: "utf8" })) as { available: boolean; loaded: string };

describe("the sidecar loader refuses a library that is not inside the sidecar", () => {
  it("a sidecar whose node_modules is empty, with a planted copy on NODE_PATH: not available, and loading says playwright_missing", () => {
    const sidecar = path.join(root, "empty");
    mkdirSync(path.join(sidecar, "node_modules"), { recursive: true });
    expect(run(sidecar, { NODE_PATH: PLANT })).toEqual({ available: false, loaded: "ERR:playwright_missing" });
  });

  it("a copy planted in a parent folder's node_modules is refused the same way", () => {
    const parent = path.join(root, "parent");
    library(path.join(parent, "node_modules", "playwright-core"), "parent-planted");
    const sidecar = path.join(parent, "fx-runner-playwright");
    mkdirSync(path.join(sidecar, "node_modules"), { recursive: true });
    expect(run(sidecar)).toEqual({ available: false, loaded: "ERR:playwright_missing" });
  });

  it("a copy planted in ~/.node_modules is refused the same way", () => {
    const fakeHome = path.join(root, "nohome");
    library(path.join(fakeHome, ".node_modules", "playwright-core"), "home-planted");
    const sidecar = path.join(root, "empty2");
    mkdirSync(path.join(sidecar, "node_modules"), { recursive: true });
    expect(run(sidecar)).toEqual({ available: false, loaded: "ERR:playwright_missing" });
  });

  it("a link inside the sidecar that points outside it is refused", () => {
    const sidecar = path.join(root, "linked");
    mkdirSync(path.join(sidecar, "node_modules"), { recursive: true });
    symlinkSync(path.join(PLANT, "playwright-core"), path.join(sidecar, "node_modules", "playwright-core"));
    expect(run(sidecar)).toEqual({ available: false, loaded: "ERR:playwright_missing" });
  });

  it("control: the real library inside the sidecar loads, also with the planted copy on NODE_PATH", () => {
    const sidecar = path.join(root, "good");
    library(path.join(sidecar, "node_modules", "playwright-core"), "good");
    expect(run(sidecar)).toEqual({ available: true, loaded: "good" });
    expect(run(sidecar, { NODE_PATH: PLANT })).toEqual({ available: true, loaded: "good" });
  });
});
