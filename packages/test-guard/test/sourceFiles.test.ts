import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSourceFiles, listSourcePaths } from "../src/sourceFiles";

const NAME = "followTimeoutBody";
// The fixture files only need to mention NAME; they never name a real package, so this file declares no import of one.
const FROM = "./elsewhere";

/** The same "only these files mention X" filter the source guards run over the list. */
const mentions = (root: string, files: string[]): string[] => files.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && readFileSync(path.join(root, f), "utf8").includes(NAME));

describe("listSourceFiles: a source guard's file list is git's, so build output never counts", () => {
  let root: string;
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  const write = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "fx-sourcefiles-"));
    git("init", "-q");
    write(".gitignore", "node_modules/\n.next/\ndist/\n");
    write("packages/runner/src/workflows/agentRun.ts", `export const ${NAME} = () => 1;\n`);
    write("packages/worker/src/index.ts", `export { ${NAME} } from "${FROM}";\n`);
    write("apps/web/workflows/agentRunFollow.ts", `import { ${NAME} } from "${FROM}";\n`);
    write("apps/web/app/page.tsx", "export default function Page() { return null; }\n");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a web build's workflow bundle (ignored by its own `*` .gitignore) is not listed, though a directory walk would find it", () => {
    // What the workflow plugin writes during `next build`: a bundle that inlines the step code, next to the app source.
    write("apps/web/app/.well-known/workflow/v1/.gitignore", "*");
    write("apps/web/app/.well-known/workflow/v1/step/route.js", `var ${NAME} = async () => {}; // bundled from packages/runner\n`);
    write("apps/web/.next/server/chunk.js", `${NAME}();\n`);
    write("packages/runner/dist/index.js", `${NAME}();\n`);
    const files = listSourceFiles(root, ["apps", "packages"]);
    expect(files).not.toContain("apps/web/app/.well-known/workflow/v1/step/route.js");
    expect(mentions(root, files)).toEqual(["apps/web/workflows/agentRunFollow.ts", "packages/runner/src/workflows/agentRun.ts", "packages/worker/src/index.ts"]);
  });

  it("a new mention in a tracked file is caught", () => {
    write("apps/web/app/page.tsx", `import { ${NAME} } from "${FROM}";\n`);
    expect(mentions(root, listSourceFiles(root, ["apps", "packages"]))).toContain("apps/web/app/page.tsx");
  });

  it("a new source file nobody has added yet is still caught (untracked but not ignored is listed)", () => {
    write("packages/api/src/sneaky.ts", `${NAME}();\n`);
    expect(mentions(root, listSourceFiles(root, ["apps", "packages"]))).toContain("packages/api/src/sneaky.ts");
  });

  it("a tracked .well-known route (real source under a dot directory) is still listed", () => {
    write("apps/web/app/.well-known/security.txt/route.ts", `${NAME}();\n`);
    git("add", "apps/web/app/.well-known/security.txt/route.ts");
    expect(mentions(root, listSourceFiles(root, ["apps"]))).toContain("apps/web/app/.well-known/security.txt/route.ts");
  });

  it("a tracked file deleted in the working tree is not listed", () => {
    rmSync(path.join(root, "packages/worker/src/index.ts"));
    expect(listSourceFiles(root, ["packages"])).not.toContain("packages/worker/src/index.ts");
  });

  it("skipDirs drops files under a directory of that name at any depth, and only those", () => {
    write("packages/runner/test/agentRun.test.ts", `${NAME}();\n`);
    write("packages/runner/src/testing.ts", `${NAME}();\n`);
    git("add", "-A");
    const files = listSourceFiles(root, ["packages"], ["test"]);
    expect(files).not.toContain("packages/runner/test/agentRun.test.ts");
    expect(files).toContain("packages/runner/src/testing.ts");
  });

  it("listSourcePaths gives the same files as absolute paths", () => {
    expect(listSourcePaths(root, ["packages"])).toEqual(listSourceFiles(root, ["packages"]).map((f) => path.join(root, f)));
  });

  it("fails closed outside a git checkout instead of falling back to a walk", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "fx-sourcefiles-plain-"));
    // In case the temp directory itself sits inside some checkout, git must not look above it.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
    try {
      mkdirSync(path.join(plain, "apps"));
      expect(() => listSourceFiles(plain, ["apps"])).toThrow(/needs a git checkout/);
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
