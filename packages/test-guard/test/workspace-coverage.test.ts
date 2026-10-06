/**
 * Closes the hole that let `packages/roles` ship five test files -- plus a
 * vitest config missing the model-call guard's setupFiles entry -- with
 * nothing ever executing them: `vitest.workspace.ts`'s own header comment
 * says "New packages/apps must add a project here with the same setupFiles
 * entry", but nothing enforced it. This file is that enforcement: it fails
 * the moment a new `apps/*`/`packages/*` package is added without a
 * matching `vitest.workspace.ts` entry, or an entry's vitest config drops
 * the guard.
 *
 * Reads vitest.workspace.ts as plain text rather than importing it as a TS
 * module: importing it would pull its own type-correctness into this
 * package's `tsc --noEmit` program, which is a separate concern from what
 * this test checks.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKSPACE_FILE_PATH = join(REPO_ROOT, "vitest.workspace.ts");

/**
 * Directories the root pnpm-workspace.yaml leaves out with a `- "!dir"` entry. Such a package is not part of
 * the root workspace (it has its own lockfile and runs on its own), so vitest.workspace.ts must not list it.
 */
export function listExcludedWorkspaceDirs(workspaceYaml: string): string[] {
  return [...workspaceYaml.matchAll(/^\s*-\s*["']?!([^"'\s#]+)["']?\s*(?:#.*)?$/gm)].map((m) => m[1]!.replace(/\/$/, ""));
}

/** Every `apps/*` or `packages/*` directory that has its own package.json, minus the ones the root workspace excludes. */
export function listWorkspacePackageDirs(repoRoot: string): string[] {
  const dirs: string[] = [];
  const yamlPath = join(repoRoot, "pnpm-workspace.yaml");
  const excluded = new Set(existsSync(yamlPath) ? listExcludedWorkspaceDirs(readFileSync(yamlPath, "utf-8")) : []);
  for (const parent of ["apps", "packages"]) {
    const parentDir = join(repoRoot, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = `${parent}/${entry.name}`;
      if (excluded.has(pkgDir)) continue;
      if (existsSync(join(repoRoot, pkgDir, "package.json"))) dirs.push(pkgDir);
    }
  }
  return dirs.sort();
}

/** Which of `packageDirs` are not literally quoted anywhere in the workspace file's text. */
export function findMissingFromWorkspace(packageDirs: string[], workspaceSource: string): string[] {
  return packageDirs.filter((dir) => !workspaceSource.includes(`"${dir}"`));
}

/**
 * Inline `{ test: { ... } }` entries in vitest.workspace.ts (`test-guard`
 * and `web` today), each as its declared root path plus whether that same
 * block declares `setupFiles`. Assumes a flat property list inside each
 * block (no nested `{}`) -- true of every inline entry in this file today.
 */
export function extractInlineEntries(
  workspaceSource: string,
): { root: string; hasSetupFiles: boolean }[] {
  const entries: { root: string; hasSetupFiles: boolean }[] = [];
  for (const match of workspaceSource.matchAll(/\{\s*test:\s*\{([^{}]*)\}\s*,?\s*\}/gs)) {
    const block = match[1];
    if (block === undefined) continue;
    const rootMatch = block.match(/root:\s*["']([^"']+)["']/);
    const root = rootMatch?.[1];
    if (root === undefined) continue;
    entries.push({ root, hasSetupFiles: /setupFiles\s*:/.test(block) });
  }
  return entries;
}

/** True if a vitest.config.ts source wires in the model-call guard's setupFiles. */
export function hasGuardSetupFiles(source: string): boolean {
  return /setupFiles\s*:/.test(source) && /test-guard\/src\/setup\.ts/.test(source);
}

describe("packages the root pnpm workspace excludes", () => {
  it("are read from the `- \"!dir\"` entries of pnpm-workspace.yaml", () => {
    const yaml = 'packages:\n  - "apps/*"\n  - "!packages/doc-templates"\n  - \'!packages/other/\' # why\n# - "!packages/commented"\n';
    expect(listExcludedWorkspaceDirs(yaml)).toEqual(["packages/doc-templates", "packages/other"]);
  });

  it("are not required in vitest.workspace.ts (this repo excludes packages/doc-templates)", () => {
    const yaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf-8");
    expect(listExcludedWorkspaceDirs(yaml)).toContain("packages/doc-templates");
    expect(listWorkspacePackageDirs(REPO_ROOT)).not.toContain("packages/doc-templates");
  });
});

describe("every workspace package is registered in vitest.workspace.ts", () => {
  const packageDirs = listWorkspacePackageDirs(REPO_ROOT);
  const workspaceSource = readFileSync(WORKSPACE_FILE_PATH, "utf-8");

  it("found at least one workspace package to check (sanity -- an empty list would make every case below vacuously pass)", () => {
    expect(packageDirs.length).toBeGreaterThan(0);
  });

  for (const pkgDir of packageDirs) {
    it(`${pkgDir} is listed in vitest.workspace.ts`, () => {
      expect(findMissingFromWorkspace([pkgDir], workspaceSource)).toEqual([]);
    });
  }

  it("deliberate-failure fixture: flags a package dir that is not quoted anywhere in the source", () => {
    expect(findMissingFromWorkspace(["packages/not-real"], workspaceSource)).toEqual([
      "packages/not-real",
    ]);
  });
});

describe("every workspace-listed package's vitest config wires in the model-call guard", () => {
  const workspaceSource = readFileSync(WORKSPACE_FILE_PATH, "utf-8");
  const inlineEntries = extractInlineEntries(workspaceSource);
  const inlineRoots = new Set(inlineEntries.map((e) => e.root));

  it("found the inline entries this repo is known to declare today (sanity)", () => {
    expect(inlineRoots.has("packages/test-guard")).toBe(true);
    expect(inlineRoots.has("apps/web")).toBe(true);
  });

  for (const entry of inlineEntries) {
    it(`${entry.root} (inline workspace entry) declares setupFiles`, () => {
      expect(entry.hasSetupFiles).toBe(true);
    });
  }

  for (const pkgDir of listWorkspacePackageDirs(REPO_ROOT)) {
    if (inlineRoots.has(pkgDir)) continue; // inline entries are checked above, from the block itself
    const configPath = join(REPO_ROOT, pkgDir, "vitest.config.ts");
    it(`${pkgDir}/vitest.config.ts exists and wires in the guard's setupFiles`, () => {
      expect(existsSync(configPath)).toBe(true);
      expect(hasGuardSetupFiles(readFileSync(configPath, "utf-8"))).toBe(true);
    });
  }

  it("deliberate-failure fixture: does not flag a config with setupFiles pointed at something else", () => {
    expect(hasGuardSetupFiles('setupFiles: ["./other-setup.ts"]')).toBe(false);
  });

  it("deliberate-failure fixture: flags a config with no setupFiles at all", () => {
    expect(hasGuardSetupFiles("export default { test: { environment: 'node' } };")).toBe(false);
  });
});
