import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSourcePaths } from "../../../../packages/test-guard/src/sourceFiles.js";

/**
 * FIXROUND-BASE-SYNC: the `branch_sync` installation-client kind holds contents:write, so the only thing that may open it is the branch sync port, which makes
 * one fixed sequence of calls. This guard keeps a later caller from naming the kind anywhere else: outside test code, the word appears only where the kind and
 * its token purpose are defined and in the port that opens it.
 */
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", "test", "tests", "__tests__"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/;
const ALLOWED = ["packages/github/src/branchSync.ts", "packages/github/src/installationHttp.ts", "packages/github/src/installationToken.ts"];
const KIND = /\bbranch_sync\b/;

function sources(): string[] {
  return listSourcePaths(ROOT, ["apps", "packages"], SKIP_DIRS).filter((file) => SOURCE.test(file) && !TEST_FILE.test(path.basename(file)));
}

describe("the branch_sync installation-client kind", () => {
  it("is named in non-test source only by its definitions and by the branch sync port", () => {
    const named = sources()
      .filter((file) => KIND.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .sort();
    expect(named).toEqual([...ALLOWED].sort());
  });

  it("opens the kind with a literal in the port, so the check above sees a caller", () => {
    expect(readFileSync(path.join(ROOT, "packages/github/src/branchSync.ts"), "utf8")).toMatch(/open\("branch_sync"/);
  });
});
