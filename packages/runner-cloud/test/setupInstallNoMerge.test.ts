import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D#845 ON-20a (Ruling 95): the install pull request never merges by itself. This repo-wide guard reads every non-test source file of the packages and the web app and holds that the port's one merge
 * call is written in two files only (the port that defines it, and the merge route's module), that the module is reached from one route handler only, and that the install step, the watch and the
 * reconcile job (everything that runs without a person) name it nowhere.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKIP = new Set(["node_modules", ".next", "dist", "test", "tests", ".generated", "coverage"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name) && statSync(full).size < 2_000_000) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const roots = [...readdirSync(path.join(ROOT, "packages")).map((p) => path.join(ROOT, "packages", p, "src")), path.join(ROOT, "apps/web/app"), path.join(ROOT, "apps/web/lib")].filter((d) => {
  try {
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
});
const files = roots.flatMap((d) => sources(d));
const naming = (word: RegExp) => files.filter((f) => word.test(readFileSync(f, "utf8"))).map(rel).sort();

describe("nothing merges the install pull request without a person's click", () => {
  it("reads the tree it means to", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(rel)).toContain("packages/runner-cloud/src/setupInstallPr.ts");
    expect(files.map(rel)).toContain("packages/reconcile/src/jobs/setupInstallPr.ts");
  });

  it("names the port's merge call in its definition, in the install merge route's module and in the twin's Merge module (a person's click too, D#845 ON-27d4c), nowhere else", () => {
    expect(naming(/\bmergeInstall\b/)).toEqual(["packages/runner-cloud/src/runPullRequest.ts", "packages/runner-cloud/src/setupInstallMerge.ts", "packages/runner-cloud/src/twinMerge.ts"]);
  });

  it("the twin's Merge calls it once, only after the owner or admin check, and its function is reached from the twin merge route and nothing that runs without a person", () => {
    const text = readFileSync(path.join(ROOT, "packages/runner-cloud/src/twinMerge.ts"), "utf8");
    expect(text.match(/\.mergeInstall\(/g)).toHaveLength(1);
    const merge = text.slice(text.indexOf("export async function mergeTwinPr"));
    expect(merge.indexOf('role !== "owner" && role !== "admin"')).toBeGreaterThan(-1);
    expect(merge.indexOf('role !== "owner" && role !== "admin"')).toBeLessThan(merge.indexOf(".mergeInstall("));
    expect(naming(/\bmergeTwinPr\b/)).toEqual(["apps/web/app/api/v1/[...path]/route.ts", "packages/runner-cloud/src/index.ts", "packages/runner-cloud/src/twinMerge.ts"]);
  });

  it("calls it once, from the merge function that checks the person's role first", () => {
    const text = readFileSync(path.join(ROOT, "packages/runner-cloud/src/setupInstallMerge.ts"), "utf8");
    expect(text.match(/\.mergeInstall\(/g)).toHaveLength(1);
    const merge = text.slice(text.indexOf("export async function installMergeRun"));
    expect(merge.indexOf('role !== "owner" && role !== "admin"')).toBeGreaterThan(-1);
    expect(merge.indexOf('role !== "owner" && role !== "admin"')).toBeLessThan(merge.indexOf(".mergeInstall("));
  });

  it("reaches the merge function from the merge route's handler only", () => {
    expect(naming(/\binstallMergeRun\b/)).toEqual(["apps/web/app/api/v1/setups/[id]/install/merge/handler.ts", "packages/runner-cloud/src/index.ts", "packages/runner-cloud/src/setupInstallMerge.ts"]);
  });

  it("the work that runs without a person (the install step, the reconcile job and its web handler, the watch) names neither the merge call nor the merge module", () => {
    const unattended = ["packages/runner-cloud/src/setupInstallPr.ts", "packages/reconcile/src/jobs/setupInstallPr.ts", "apps/web/app/api/cron/reconcile/handler.ts", "packages/github/src/eventMapper.ts", "packages/core/src/repos/twinSweep.ts", "apps/web/lib/twinSweepPorts.ts"];
    for (const f of unattended) {
      const text = readFileSync(path.join(ROOT, f), "utf8");
      expect(text, f).not.toMatch(/mergeInstall|installMergeRun|setupInstallMerge|mergeTwinPr|twinMerge|merge_method/);
    }
  });
});
