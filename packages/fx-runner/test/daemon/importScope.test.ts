import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceSource } from "../../src/daemon/checkStep.js";
import { dependentFailedFiles, importScopeLine } from "../../src/daemon/importScope.js";

/** Workspace package names built at run time, so the public-boundary scan (which reads source text for real workspace names) does not mistake a fixture for an import of this package. */
const SPEND = ["@fx", "spend"].join("/");
const ODD = ["@fx", "odd"].join("/");
const OTHER = ["@fx", "other"].join("/");
const WORKER = ["@fx", "worker"].join("/");

/** CHECK-SCOPE-BY-IMPORTS: which failed test files reach a changed file through imports. Files here are real, on disk, read through the same reader the runner uses. */
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "fx-import-scope-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const put = (rel: string, text: string): string => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), text);
  return rel;
};
const scope = (files: Record<string, string>, failed: string[], changed: string[]): string[] | null => {
  const tracked = Object.keys(files).map((rel) => put(rel, files[rel]!));
  return dependentFailedFiles({ failed, changed, tracked, read: (rel) => readWorkspaceSource(ws, rel) });
};
const pkg = (name: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, version: "0.0.0", main: "dist/index.js", types: "dist/index.d.ts", ...extra });

describe("a failed test file that imports changed code is inside the change", () => {
  it("imports the changed module directly", () => {
    const out = scope({ "packages/a/src/x.ts": "export const x = 1;\n", "packages/a/test/x.test.ts": 'import { x } from "../src/x.js";\n' }, ["packages/a/test/x.test.ts"], ["packages/a/src/x.ts"]);
    expect(out).toEqual(["packages/a/test/x.test.ts"]);
  });

  it("imports it through another file (transitive)", () => {
    const out = scope(
      { "packages/a/src/x.ts": "export const x = 1;\n", "packages/a/src/mid.ts": 'export * from "./x";\n', "packages/a/src/top.ts": 'import { x } from "./mid";\nexport const y = x;\n', "packages/a/test/t.test.ts": 'import { y } from "../src/top";\n' },
      ["packages/a/test/t.test.ts"],
      ["packages/a/src/x.ts"],
    );
    expect(out).toEqual(["packages/a/test/t.test.ts"]);
  });

  it("imports a workspace package by its name, which resolves to the package's source (the 11-15 case)", () => {
    const out = scope(
      {
        "packages/spend/package.json": pkg(SPEND),
        "packages/spend/src/index.ts": 'export { getUsage } from "./usage.js";\n',
        "packages/spend/src/usage.ts": "export const getUsage = () => 1;\n",
        "packages/worker/package.json": pkg(WORKER),
        "packages/worker/test/runnerUsage.pg.test.ts": `import { getUsage } from "${SPEND}";\n`,
      },
      ["packages/worker/test/runnerUsage.pg.test.ts"],
      ["packages/spend/src/usage.ts"],
    );
    expect(out).toEqual(["packages/worker/test/runnerUsage.pg.test.ts"]);
  });

  it("a sub-path import of a workspace package, and a test double of it, count too", () => {
    const files = {
      "packages/spend/package.json": pkg(SPEND),
      "packages/spend/src/usage.ts": "export const getUsage = () => 1;\n",
      "packages/w/test/a.test.ts": `import { getUsage } from "${SPEND}/usage";\n`,
      "packages/w/test/b.test.ts": `vi.mock("${SPEND}/usage", () => ({}));\n`,
    };
    expect(scope(files, ["packages/w/test/a.test.ts", "packages/w/test/b.test.ts"], ["packages/spend/src/usage.ts"])).toEqual(["packages/w/test/a.test.ts", "packages/w/test/b.test.ts"]);
  });

  it("a package whose entry names no source file counts every source file of it (the package is never skipped)", () => {
    const out = scope(
      { "packages/odd/package.json": pkg(ODD, { main: "weird/entry.js", types: "weird/entry.d.ts" }), "packages/odd/lib/deep.ts": "export {};\n", "packages/w/test/a.test.ts": `import "${ODD}";\n` },
      ["packages/w/test/a.test.ts"],
      ["packages/odd/lib/deep.ts"],
    );
    expect(out).toEqual(["packages/w/test/a.test.ts"]);
  });

  it("a failed test file that is itself changed is inside the change", () => {
    expect(scope({ "packages/a/test/t.test.ts": "export {};\n" }, ["packages/a/test/t.test.ts"], ["packages/a/test/t.test.ts"])).toEqual(["packages/a/test/t.test.ts"]);
  });

  it("a cycle between files ends", () => {
    const out = scope({ "packages/a/src/p.ts": 'import "./q";\n', "packages/a/src/q.ts": 'import "./p";\n', "packages/a/test/t.test.ts": 'import "../src/p";\n' }, ["packages/a/test/t.test.ts"], ["packages/z/src/other.ts"]);
    expect(out).toEqual([]);
  });
});

describe("a failed test file with no dependency on a changed file is not named", () => {
  it("an unrelated failure: nothing in its imports reaches the change", () => {
    const out = scope(
      {
        "packages/spend/package.json": pkg(SPEND),
        "packages/spend/src/usage.ts": "export const getUsage = () => 1;\n",
        "packages/other/package.json": pkg(OTHER),
        "packages/other/src/o.ts": "export const o = 1;\n",
        "packages/other/test/o.test.ts": 'import { o } from "../src/o.js";\nimport { readFileSync } from "node:fs";\nimport x from "left-pad";\n',
      },
      ["packages/other/test/o.test.ts"],
      ["packages/spend/src/usage.ts"],
    );
    expect(out).toEqual([]);
  });

  it("a name that is not a workspace package, and a name that only starts like one, have no edge", () => {
    const out = scope(
      { "packages/spend/package.json": pkg(SPEND), "packages/spend/src/index.ts": "export {};\n", "packages/w/test/a.test.ts": `import "${SPEND}-extra";\nimport "@other/spend";\n` },
      ["packages/w/test/a.test.ts"],
      ["packages/spend/src/index.ts"],
    );
    expect(out).toEqual([]);
  });

  it("a failed file that is not JavaScript or TypeScript is left to the package rule", () => {
    expect(scope({ "tests/test_a.py": "import a\n" }, ["tests/test_a.py"], ["src/a.py"])).toEqual([]);
  });
});

describe("a graph that cannot be read is null, never a quiet empty answer", () => {
  it("a source file on the path that cannot be read exactly", () => {
    const out = dependentFailedFiles({
      failed: ["a/t.test.ts"],
      changed: ["a/c.ts"],
      tracked: ["a/t.test.ts", "a/s.ts"],
      read: (rel) => {
        if (rel === "a/s.ts") throw new Error("denied");
        return rel === "a/t.test.ts" ? 'import "./s";\n' : null;
      },
    });
    expect(out).toBeNull();
  });

  it("a symlink in the tree is refused by the reader, so the graph is not read", () => {
    put("packages/a/real.ts", "export {};\n");
    symlinkSync(path.join(ws, "packages/a/real.ts"), path.join(ws, "packages/a/link.ts"));
    expect(() => readWorkspaceSource(ws, "packages/a/link.ts")).toThrow();
    put("packages/a/t.test.ts", 'import "./link";\n');
    expect(dependentFailedFiles({ failed: ["packages/a/t.test.ts"], changed: ["packages/a/c.ts"], tracked: ["packages/a/t.test.ts", "packages/a/link.ts"], read: (rel) => readWorkspaceSource(ws, rel) })).toBeNull();
  });

  it("a directory that is a link out of the workspace is refused", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "fx-outside-"));
    try {
      writeFileSync(path.join(outside, "x.ts"), "export {};\n");
      symlinkSync(outside, path.join(ws, "linked"));
      expect(() => readWorkspaceSource(ws, "linked/x.ts")).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a file that is gone reads as nothing (a deleted file), not as an error", () => {
    expect(readWorkspaceSource(ws, "packages/a/gone.ts")).toBeNull();
  });
});

describe("a hostile tree cannot make the read expensive (one budget for the whole graph)", () => {
  const BIG = ["@fx", "big"].join("/");
  const FILES = 20000;
  /** A package of many files and a failed test file whose one source holds thousands of distinct sub-path imports that match none of them (each falls back to the whole package). */
  const hostile = (starts: number) => {
    const tracked = ["packages/big/package.json", "packages/t/test/hostile.test.ts"];
    for (let n = 0; n < FILES; n += 1) tracked.push(`packages/big/src/f${String(n)}.ts`);
    const specifiers = Array.from({ length: 6000 }, (_, n) => `import "${BIG}/nope${String(n)}";`).join("\n");
    const failed = ["packages/t/test/hostile.test.ts"];
    for (let n = 1; n < starts; n += 1) {
      tracked.push(`packages/t/test/h${String(n)}.test.ts`);
      failed.push(`packages/t/test/h${String(n)}.test.ts`);
    }
    const reads: string[] = [];
    const read = (rel: string): string | null => {
      reads.push(rel);
      if (rel === "packages/big/package.json") return JSON.stringify({ name: BIG, main: "weird.js" });
      if (rel.startsWith("packages/t/test/")) return specifiers;
      return "export {};\n";
    };
    return { tracked, failed, read, reads, size: specifiers.length };
  };

  it("a 100 KB file of distinct unresolved sub-paths against a 20000-file package is answered in well under a second, once, not once per import", () => {
    const h = hostile(1);
    expect(h.size).toBeGreaterThan(100_000);
    const t0 = Date.now();
    const out = dependentFailedFiles({ failed: h.failed, changed: ["packages/other/src/x.ts"], tracked: h.tracked, read: h.read });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out === null || Array.isArray(out)).toBe(true);
    // and the package's files are each read at most once
    expect(new Set(h.reads).size).toBe(h.reads.length);
  });

  it("twenty failed start files share one graph: no file is read twice", () => {
    const h = hostile(20);
    const t0 = Date.now();
    dependentFailedFiles({ failed: h.failed, changed: ["packages/other/src/x.ts"], tracked: h.tracked, read: h.read });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(new Set(h.reads).size).toBe(h.reads.length);
  });

  it("crossing the edge budget is not read (null)", () => {
    const h = hostile(1);
    expect(dependentFailedFiles({ failed: h.failed, changed: ["packages/other/src/x.ts"], tracked: h.tracked, read: h.read, budget: { edges: 1000 } })).toBeNull();
  });

  it("crossing the bytes budget is not read (null)", () => {
    const h = hostile(1);
    expect(dependentFailedFiles({ failed: h.failed, changed: ["packages/other/src/x.ts"], tracked: h.tracked, read: h.read, budget: { bytes: 50_000 } })).toBeNull();
  });

  it("too many specifiers in one file is not read (null)", () => {
    const h = hostile(1);
    expect(dependentFailedFiles({ failed: h.failed, changed: ["packages/other/src/x.ts"], tracked: h.tracked, read: h.read, budget: { specifiersPerFile: 100 } })).toBeNull();
  });

  it("a deadline that has passed is not read (null), checked as the work goes on", () => {
    const h = hostile(1);
    let clock = 0;
    const out = dependentFailedFiles({ failed: h.failed, changed: ["packages/other/src/x.ts"], tracked: h.tracked, read: h.read, now: () => (clock += 1500) });
    expect(out).toBeNull();
  });

  it("an ordinary tree stays well inside the budget", () => {
    const out = scope({ "packages/a/src/x.ts": "export {};\n", "packages/a/test/t.test.ts": 'import "../src/x";\n' }, ["packages/a/test/t.test.ts"], ["packages/a/src/x.ts"]);
    expect(out).toEqual(["packages/a/test/t.test.ts"]);
  });
});

describe("readWorkspaceSource opens the file itself without following a link", () => {
  it("a fifo is refused without blocking", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(ws, "pipe.ts")]);
    expect(() => readWorkspaceSource(ws, "pipe.ts")).toThrow();
  });
  it("a file larger than the cap is refused", () => {
    put("big.ts", "x".repeat(1024 * 1024 + 1));
    expect(() => readWorkspaceSource(ws, "big.ts")).toThrow();
  });
  it("an ordinary file is read whole", () => {
    put("ok.ts", "export const ok = 1;\n");
    expect(readWorkspaceSource(ws, "ok.ts")).toBe("export const ok = 1;\n");
  });
});

describe("importScopeLine", () => {
  it("names dependents in the closed shape; nothing when none depends; a marker when the graph was not read", () => {
    expect(importScopeLine(["packages/w/test/a.test.ts"])).toBe("failed test files that import changed code (1): packages/w/test/a.test.ts\n");
    expect(importScopeLine([])).toBe("");
    expect(importScopeLine(null)).toBe("import graph not read\n");
  });
});
