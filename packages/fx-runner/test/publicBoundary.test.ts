import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { TOKEN_SHAPE_PATTERN_SOURCES } from "@fulcrumaxe/runner-protocol";
import { describe, expect, it } from "vitest";
import { IMPORT_SPECIFIER, PACKAGE_DIR, filesUnder, opaqueLoads } from "./helpers/srcFiles.js";

const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as {
  private?: boolean;
  license?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const sourceFiles = filesUnder(path.join(PACKAGE_DIR, "src")).filter((f) => f.endsWith(".ts"));
const testFiles = filesUnder(path.join(PACKAGE_DIR, "test")).filter((f) => f.endsWith(".ts"));

describe("licence and manifest", () => {
  it("LICENSE is the repository's own LICENSE, byte for byte", () => {
    const own = readFileSync(path.join(PACKAGE_DIR, "LICENSE"));
    const root = readFileSync(path.join(PACKAGE_DIR, "..", "..", "LICENSE"));
    expect(createHash("sha256").update(own).digest("hex")).toBe(createHash("sha256").update(root).digest("hex"));
  });

  it("package.json is private, proprietary, names the Node minimum and the package", () => {
    expect(manifest).toMatchObject({ name: "@fulcrumaxe/fx-runner", private: true, license: "UNLICENSED", engines: { node: ">=22.22.2" } });
  });

  it("has a README", () => {
    expect(existsSync(path.join(PACKAGE_DIR, "README.md"))).toBe(true);
  });

  it("depends on no @anthropic-ai package, in any dependency list", () => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(all).filter((name) => name.startsWith("@anthropic-ai/"))).toEqual([]);
  });
});

describe("boundary: what the source may import, and every workspace import is declared", () => {
  const specifier = IMPORT_SPECIFIER;

  it("src loads no module in a way the import scan cannot see: no createRequire, no computed import() or require()", () => {
    for (const file of sourceFiles) expect(opaqueLoads(readFileSync(file, "utf8")), file).toEqual([]);
  });

  it("the scans see template-literal and computed loads, and createRequire", () => {
    const tick = "`";
    const sample = `import(${tick}./${"$"}{name}.js${tick}); require(name); createRequire(import.meta.url); import(${tick}node:fs${tick}); import("node:fs");`;
    expect(opaqueLoads(sample)).toEqual(["createRequire", "import(`./${name}.js`)", "require(name)"]);
    const found = [...`import(${tick}@scope/pkg${tick})`.matchAll(specifier)].map((m) => m[1]);
    expect(found).toEqual(["@scope/pkg"]);
  });

  // The third-party libraries the runner may import: the TUF client its updater is built on (D#6 R6-2a, correction C38 section 2), and js-yaml (D#6 C44-4), which
  // parses a repo's lockfile and workspace file for the host-side install's pre-check (exact version, in dependencies).
  // It is declared exactly in package.json (a test below pins that), and no other third-party import is allowed.
  const THIRD_PARTY = new Set(["tuf-js", "tuf-js/dist/error.js", "js-yaml"]);
  // The one protocol subpath src may import besides the root (D#598 P1f-3): the public-push route and its scanner, which run the version-control tool for the
  // run-end hook. Only this exact subpath; the root never exports them (runner-protocol's root-closure test), and the files below are the only importers.
  const PLANE_PUSH_SUBPATH = "@fulcrumaxe/runner-protocol/planePush";
  const PLANE_PUSH_IMPORTERS = ["src/commands/run.ts", "src/daemon/planePush.ts"];

  it("src imports only itself, node built-ins, the protocol package and the TUF client", () => {
    const violations: string[] = [];
    for (const file of sourceFiles) {
      for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
        const spec = match[1]!;
        const ok = spec.startsWith("node:") || (spec.startsWith(".") && path.resolve(path.dirname(file), spec).startsWith(PACKAGE_DIR + path.sep)) || spec === "@fulcrumaxe/runner-protocol" || spec === PLANE_PUSH_SUBPATH || THIRD_PARTY.has(spec);
        if (!ok) violations.push(`${path.relative(PACKAGE_DIR, file)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the planePush subpath is imported only by the run-end hook and the command that wires it, and no other protocol subpath is allowed", () => {
    const importers = new Set<string>();
    for (const file of sourceFiles) {
      for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
        if (match[1]!.startsWith("@fulcrumaxe/runner-protocol/")) {
          expect(match[1], path.relative(PACKAGE_DIR, file)).toBe(PLANE_PUSH_SUBPATH);
          importers.add(path.relative(PACKAGE_DIR, file).split(path.sep).join("/"));
        }
      }
    }
    expect([...importers].sort()).toEqual(PLANE_PUSH_IMPORTERS);
  });

  const GIT_RUNNING = ["routeAndPush", "createGitTransport", "planePushGit", "assertSafeLocalConfig", "gitCommitSource"];
  const rootGitImports = (text: string): string[] =>
    [...text.matchAll(/\bimport\b[^;]*?\bfrom\s*["']@fulcrumaxe\/runner-protocol["']/g)].flatMap((m) => GIT_RUNNING.filter((name) => new RegExp(`\\b${name}\\b`).test(m[0])));

  it("no src file names a git-running export of the protocol package in an import of its root", () => {
    for (const file of sourceFiles) expect(rootGitImports(readFileSync(file, "utf8")), path.relative(PACKAGE_DIR, file)).toEqual([]);
  });

  it("control: the root-import check fires on a git-running name from the root, and not on the subpath or an ordinary import", () => {
    expect(rootGitImports('import { routeAndPush, type X } from "@fulcrumaxe/runner-protocol";')).toEqual(["routeAndPush"]);
    expect(rootGitImports('import {\n  createGitTransport,\n} from "@fulcrumaxe/runner-protocol";')).toEqual(["createGitTransport"]);
    expect(rootGitImports(`import { routeAndPush } from "${PLANE_PUSH_SUBPATH}";`)).toEqual([]);
    expect(rootGitImports('import { PlanePushTokenReply } from "@fulcrumaxe/runner-protocol";')).toEqual([]);
  });

  it("every workspace package a file imports is in package.json: src in dependencies, tests in either list", () => {
    const missing: string[] = [];
    for (const file of [...sourceFiles, ...testFiles]) {
      const inTest = file.startsWith(path.join(PACKAGE_DIR, "test"));
      const declared = inTest ? { ...manifest.dependencies, ...manifest.devDependencies } : { ...manifest.dependencies };
      for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
        const spec = match[1]!;
        const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if ((name.startsWith("@fx/") || name.startsWith("@fulcrumaxe/")) && !declared[name]) missing.push(`${path.relative(PACKAGE_DIR, file)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("js-yaml is declared as an exact version, in dependencies", () => {
    expect(manifest.dependencies?.["js-yaml"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the TUF client is declared as an exact version, in dependencies", () => {
    expect(manifest.dependencies?.["tuf-js"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies?.["@tufjs/models"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("src never reaches into another package by path", () => {
    for (const file of sourceFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/\.\.\/\.\.\/\.\.\/|packages\//);
  });
});

describe("G4: nothing secret in the source, the tests or the README", () => {
  it("holds no credential-shaped string", () => {
    const found: string[] = [];
    for (const file of [...sourceFiles, ...testFiles, path.join(PACKAGE_DIR, "README.md")]) {
      const text = readFileSync(file, "utf8");
      for (const source of TOKEN_SHAPE_PATTERN_SOURCES) if (new RegExp(source).test(text)) found.push(`${path.relative(PACKAGE_DIR, file)}: ${source}`);
    }
    expect(found).toEqual([]);
  });

  it("the scan can find a token: the pattern list is not empty and matches a planted one", () => {
    expect(TOKEN_SHAPE_PATTERN_SOURCES.length).toBeGreaterThan(0);
    const planted = ["sk-ant-", "api03-", "A".repeat(24)].join("");
    expect(TOKEN_SHAPE_PATTERN_SOURCES.some((source) => new RegExp(source).test(`const key = "${planted}";`))).toBe(true);
  });
});
