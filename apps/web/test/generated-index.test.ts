import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * D#500: apps/web/app/_generated/workspace-index.ts is generated, not committed (it embeds a content hash, so a
 * committed copy conflicted whenever two apps/workspace PRs merged). So every entry point that reads it must make it
 * first. These tests run the REAL package scripts (`pnpm --filter web typecheck|build`, the web vitest project) in a
 * scratch copy of the tracked tree where the file does not exist, and assert the command succeeds and wrote the file.
 */
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(WEB_DIR, "..", "..");
const GENERATED = path.join("apps", "web", "app", "_generated", "workspace-index.ts");

type Pkg = { scripts: Record<string, string> };
const webPkg = (): Pkg => JSON.parse(fs.readFileSync(path.join(WEB_DIR, "package.json"), "utf8")) as Pkg;

let scratch = "";

/** Copies every tracked file (as it is on disk now) and links each node_modules, leaving the generated file absent. */
function makeScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d500-scratch-"));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const rel of tracked) {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) continue; // deleted in the working tree
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(dir, rel));
  }
  for (const base of [".", "apps", "packages", "sites"]) {
    const parent = path.join(REPO_ROOT, base);
    const names = base === "." ? ["."] : fs.existsSync(parent) ? fs.readdirSync(parent) : [];
    for (const name of names) {
      const nm = path.join(parent, name, "node_modules");
      const into = path.join(dir, base, name);
      if (!fs.existsSync(nm) || !fs.existsSync(into)) continue;
      if (base !== ".") {
        fs.symlinkSync(nm, path.join(into, "node_modules"), "dir");
        continue;
      }
      // pnpm refuses a symlinked root node_modules (task run state dir): make it real, link its entries.
      fs.mkdirSync(path.join(into, "node_modules"));
      for (const entry of fs.readdirSync(nm)) {
        if (entry.startsWith(".pnpm-task-run-state")) continue; // pnpm's own per-run state; must be a real dir
        fs.symlinkSync(path.join(nm, entry), path.join(into, "node_modules", entry));
      }
    }
  }
  return dir;
}

function run(cmd: string, args: string[]): { code: number | null; out: string } {
  // `env` drops the Vercel plugin's hint variable (it breaks the build scripts) without enumerating process.env.
  const res = spawnSync("env", ["-u", "VERCEL_PLUGIN_BOOTSTRAP_HINTS", "CI=1", cmd, ...args], {
    cwd: scratch,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const generatedInScratch = (): string => path.join(scratch, GENERATED);

describe("generated workspace index (D#500)", () => {
  beforeAll(() => {
    scratch = makeScratch();
  }, 120_000);
  afterAll(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("is untracked and ignored by git", () => {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", GENERATED], { cwd: REPO_ROOT });
    expect(tracked.status).not.toBe(0);
    const ignored = spawnSync("git", ["check-ignore", "-q", GENERATED], { cwd: REPO_ROOT });
    expect(ignored.status).toBe(0);
  });

  it("starts the scratch copy without the file (fresh-clone state)", () => {
    expect(fs.existsSync(generatedInScratch())).toBe(false);
  });

  it("calls the generator explicitly in dev, build and typecheck, not through pnpm pre-hooks", () => {
    const { scripts } = webPkg();
    const expandsTo = (name: string): string =>
      (scripts[name] ?? "").replace(/pnpm run ([\w:-]+)/g, (_m, other: string) => scripts[other] ?? "");
    for (const name of ["dev", "build", "typecheck"]) {
      expect(expandsTo(name), name).toContain("copy-workspace.mjs");
      expect(expandsTo(name).indexOf("copy-workspace.mjs"), name).toBeLessThan(
        Math.max(expandsTo(name).indexOf("next "), expandsTo(name).indexOf("tsc ")),
      );
      expect(scripts[`pre${name}`], `pre${name}`).toBeUndefined();
    }
  });

  it("pnpm --filter web typecheck regenerates the file and passes", () => {
    const res = run("pnpm", ["--filter", "web", "typecheck"]);
    expect(res.out.slice(-2000)).toMatch(/copy-workspace\.mjs: wrote/);
    expect(res.code, res.out.slice(-4000)).toBe(0);
    expect(fs.existsSync(generatedInScratch())).toBe(true);
  }, 240_000);

  it("the web vitest run regenerates the file and passes", () => {
    fs.rmSync(generatedInScratch(), { force: true });
    const res = run("pnpm", ["exec", "vitest", "run", "--project", "web", "apps/web/test/root-route.test.ts"]);
    expect(res.code, res.out.slice(-4000)).toBe(0);
    expect(fs.existsSync(generatedInScratch())).toBe(true);
  }, 240_000);

  it("pnpm --filter web build regenerates the file and passes", () => {
    fs.rmSync(generatedInScratch(), { force: true });
    const res = run("pnpm", ["--filter", "web", "build"]);
    expect(res.code, res.out.slice(-4000)).toBe(0);
    expect(fs.existsSync(generatedInScratch())).toBe(true);
    expect(fs.readFileSync(generatedInScratch(), "utf8")).toMatch(/<base href=\\"\/s\/[0-9a-f]+\/\\"/);
  }, 600_000);
});
