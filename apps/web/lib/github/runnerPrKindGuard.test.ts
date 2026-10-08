import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D#6 R2b-3e: the `runner_pr` installation-client kind holds contents:read, so the only thing that may open it is the pull request
 * port, which puts every call behind `localOnlyGithub`. This guard keeps a later caller from naming the kind anywhere else: outside
 * test code, the string appears only where the kind is defined and in the port's wiring.
 */
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", "test", "tests", "__tests__"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[a-z]+$/;
const ALLOWED = ["apps/web/lib/github/runnerPullRequest.ts", "packages/github/src/installationHttp.ts"];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sources(path.join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("the runner_pr installation-client kind", () => {
  it("is named in non-test source only by its definition and by the pull request port's wiring", () => {
    const named = [...sources(path.join(ROOT, "apps")), ...sources(path.join(ROOT, "packages"))]
      .filter((file) => readFileSync(file, "utf8").includes("runner_pr"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .sort();
    expect(named).toEqual([...ALLOWED].sort());
  });

  it("opens the kind with a literal in the port's wiring, so the check above sees a caller", () => {
    expect(readFileSync(path.join(ROOT, ALLOWED[0]!), "utf8")).toMatch(/open\("runner_pr"/);
  });
});
