import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listSourcePaths } from "../../../../packages/test-guard/src/sourceFiles.js";

/**
 * D#7 DP7-2d: the `revert_pr` installation-client kind holds contents write and pull requests write, so the only thing that may open it is
 * `openRevertPullRequest`, which pins it to one merged pull request and one mutation. The web app's reversal opener hands the generic installation
 * opener to that function and never names the kind. This guard keeps a later caller from naming it anywhere else. The same word is also the name of a
 * reversal plan and of a compensation row's kind (plain data, no client), in the three files listed second.
 */
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", "test", "tests", "__tests__"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/;
const CLIENT = ["packages/github/src/installationHttp.ts", "packages/github/src/installationToken.ts", "packages/github/src/revertPr.ts"];
const DATA = ["packages/db/src/reversalCompensation.ts", "packages/receipts/src/compensate.ts", "packages/receipts/src/reverse.ts"];

/** The kind as a whole token. A longer identifier such as `revert_pr_extra` does not count. */
const KIND = /\brevert_pr\b/;
/** Opening the client: the kind passed as an argument to an opener. */
const OPEN = /\bopen\(\s*["']revert_pr["']\s*,/;

function sources(): string[] {
  return listSourcePaths(ROOT, ["apps", "packages"], SKIP_DIRS).filter((file) => SOURCE.test(file) && !TEST_FILE.test(path.basename(file)));
}
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

describe("the revert_pr installation-client kind", () => {
  it("is named in non-test source only by its definition, its one opener, and the data files that share the word", () => {
    const named = sources().filter((file) => KIND.test(readFileSync(file, "utf8"))).map(rel).sort();
    expect(named).toEqual([...CLIENT, ...DATA].sort());
  });

  it("is opened only by openRevertPullRequest, and the web app's reversal opener does not name it", () => {
    const opens = sources().filter((file) => OPEN.test(readFileSync(file, "utf8"))).map(rel);
    expect(opens).toEqual(["packages/github/src/revertPr.ts"]);
    expect(KIND.test(readFileSync(path.join(ROOT, "apps/web/lib/github/reversalGit.ts"), "utf8"))).toBe(false);
  });

  it("counts the kind as a whole token only, and an open only with the kind as its first argument", () => {
    expect(KIND.test('open("revert_pr", x)')).toBe(true);
    expect(KIND.test("revert_pr_extra")).toBe(false);
    expect(OPEN.test('deps.open("revert_pr", { repoId })')).toBe(true);
    expect(OPEN.test("kind: 'revert_pr'")).toBe(false);
    // A compensation row of kind revert_pr is data, not a client.
    expect(OPEN.test('row("revert_pr", "done", null)')).toBe(false);
  });
});
