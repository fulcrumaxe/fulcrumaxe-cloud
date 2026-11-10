import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SIDECAR_DIR, buildSidecar } from "../../scripts/sidecar.mjs";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2c-2c (security review): the digest covers the sidecar's own files, but playwright-core's bundled `ws` does `require("bufferutil")` / `require("utf-8-validate")`, which Node resolves through
 * parent node_modules folders, NODE_PATH and ~/.node_modules. A copy planted there RAN during load(). These tests run the REAL loader (bin/sidecarLibrary.mjs) over a REAL built sidecar in a child
 * Node, with the planted modules in all three places (and a throwaway HOME), and assert by a marker file that planted code never runs.
 */
const root = mkdtempSync(path.join(tmpRoot(), "sidecar-fence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADDONS = ["bufferutil", "utf-8-validate"];
const plant = (nodeModules: string, marker: string): void => {
  for (const name of ADDONS) {
    mkdirSync(path.join(nodeModules, name), { recursive: true });
    writeFileSync(path.join(nodeModules, name, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
    writeFileSync(path.join(nodeModules, name, "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(path.join(marker, `${name}-${path.basename(path.dirname(nodeModules))}`))}, "ran");\nmodule.exports = {};\n`);
  }
};

const built = (() => {
  const place = path.join(root, "release", "inner");
  const dest = path.join(place, SIDECAR_DIR);
  return { place, dest, digest: buildSidecar({ dest }).digest };
})();

const probe = path.join(root, "probe.mjs");
writeFileSync(
  probe,
  `import { createRequire } from "node:module";
import path from "node:path";
import { sidecarLibrary } from ${JSON.stringify(pathToFileURL(path.join(PACKAGE_DIR, "bin", "sidecarLibrary.mjs")).href)};
const [sidecar, digest, mode] = process.argv.slice(2);
const lib = sidecarLibrary(sidecar, "playwright-core", { digest });
const out = {};
try { out.loaded = typeof (await lib.load()).chromium; } catch (e) { out.loaded = "ERR:" + e.message; }
out.env = [process.env.WS_NO_BUFFER_UTIL, process.env.WS_NO_UTF_8_VALIDATE];
// A lazy require made later, by a file inside the sidecar, goes through the same lookup.
const inside = createRequire(path.join(sidecar, "node_modules", "playwright-core", "lazy.cjs"));
out.lazy = {};
if (mode === "lazy") {
for (const name of ${JSON.stringify(ADDONS)}) { try { inside(name); out.lazy[name] = "loaded"; } catch (e) { out.lazy[name] = String(e.message).slice(0, 40); } }
try { out.lazy.builtin = typeof inside("node:fs").readFileSync; out.lazy.own = inside("./package.json").name; } catch (e) { out.lazy.builtin = "ERR:" + e.message; }
}
console.log(JSON.stringify(out));
`,
);

type Probe = { loaded: string; env: (string | null)[]; lazy: Record<string, string> };
const run = (env: Record<string, string>, mode = "load"): Probe => JSON.parse(execFileSync(process.execPath, [probe, built.dest, built.digest, mode], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" })) as Probe;

describe("planted addons outside the sidecar never run while the library loads", () => {
  it("bufferutil and utf-8-validate in a parent node_modules, on NODE_PATH and in ~/.node_modules: nothing runs, and loading still works", () => {
    const marks = path.join(root, "marks-all");
    mkdirSync(marks);
    // The sidecar's parent chain: <root>/release/inner/fx-runner-playwright -> inner, release, root. A copy in each is on Node's lookup path for the sidecar's files.
    plant(path.join(root, "release", "inner", "node_modules"), marks);
    plant(path.join(root, "release", "node_modules"), marks);
    const nodePath = path.join(root, "np", "node_modules");
    plant(nodePath, marks);
    const home = path.join(root, "home");
    plant(path.join(home, ".node_modules"), marks);
    plant(path.join(home, ".node_libraries"), marks);
    const result = run({ HOME: home, NODE_PATH: nodePath });
    expect(result.loaded).toBe("object");
    expect(readdirSync(marks)).toEqual([]);
    expect(existsSync(marks)).toBe(true);
  });

  it("the loader sets the addon switches of ws before loading", () => {
    const result = run({ HOME: path.join(root, "home2") });
    expect(result.env).toEqual(["1", "1"]);
  });

  it("a lazy require made later by a file inside the sidecar is refused, a built-in and a file of the sidecar still resolve", () => {
    const marks = path.join(root, "marks-lazy");
    mkdirSync(marks);
    plant(path.join(root, "release", "inner", "node_modules"), marks);
    const nodePath = path.join(root, "np2", "node_modules");
    plant(nodePath, marks);
    const result = run({ HOME: path.join(root, "home3"), NODE_PATH: nodePath }, "lazy");
    expect(result.lazy.bufferutil).toMatch(/^sidecar_fence/);
    expect(result.lazy["utf-8-validate"]).toMatch(/^sidecar_fence/);
    expect(result.lazy.builtin).toBe("function");
    expect(result.lazy.own).toBe("playwright-core");
    expect(readdirSync(marks)).toEqual([]);
  });
});
