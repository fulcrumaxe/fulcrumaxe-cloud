import { execFileSync, spawn } from "node:child_process";
import { pinFixture } from "../helpers/pinFixture.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit } from "../../src/daemon/git.js";
import { cleanResumedWorkspace } from "../../src/daemon/resumeClean.js";
import { testLaunch } from "../helpers/launch.js";
import { writeWorkspaceExclude } from "../../src/daemon/workspaceExclude.js";
import { runCapture } from "../../src/engines/claude/capture.js";

let root: string;
let ws: string;
let outside: string;

const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
const sh = (...args: string[]): string => execFileSync("git", args, { env: env(), encoding: "utf8" });
const put = (rel: string, text = "x"): void => {
  mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  writeFileSync(path.join(ws, rel), text);
};
const has = (rel: string): boolean => {
  try {
    lstatSync(path.join(ws, rel));
    return true;
  } catch {
    return false;
  }
};
const clean = (g: ReturnType<typeof createGit>, workspace: string, log?: (line: string) => void, capChars: number = 64 * 1024, platform: NodeJS.Platform = "linux") => cleanResumedWorkspace(g, workspace, log, capChars, platform);
const git = () => createGit({ capture: (command, args, e, timeoutMs) => runCapture(spawn, testLaunch(), command, args, e, timeoutMs) });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxr-resumeclean-"));
  ws = path.join(root, "ws");
  outside = path.join(root, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  sh("-C", ws, "init", "-q");
  writeFileSync(path.join(ws, ".gitignore"), ".next/\ndist/\nnode_modules/\n.env\nlink\n*.log\n");
  put("src/app.ts", "tracked");
  sh("-C", ws, "add", "-A");
  sh("-C", ws, "commit", "-q", "-m", "base");
  pinFixture(ws);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cleanResumedWorkspace", () => {
  it("removes stale build output and keeps node_modules, .claude, stubs and untracked non-ignored files", async () => {
    put("apps/web/.next/server/page.js");
    put("apps/web/.next/cache/a.bin");
    put("dist/index.js");
    put("debug.log");
    put("node_modules/pkg/index.js");
    put("apps/web/node_modules/pkg/index.js");
    put("dist/node_modules/inner/index.js"); // a node_modules below an ignored directory keeps its parents too
    put(".claude/settings.json");
    put(".env", "");
    put("notes-by-agent.md", "work in progress"); // untracked and NOT ignored: the agent's own work
    writeFileSync(path.join(ws, ".gitignore"), ".next/\ndist/\nnode_modules/\n.env\nlink\n*.log\n.claude/\n");
    sh("-C", ws, "add", ".gitignore");
    sh("-C", ws, "commit", "-q", "-m", "ignore claude");
    const lines: string[] = [];
    const counts = await clean(git(), ws, (line) => lines.push(line));
    expect(has("apps/web/.next")).toBe(false);
    expect(has("dist/index.js")).toBe(false);
    expect(has("debug.log")).toBe(false);
    expect(has("node_modules/pkg/index.js")).toBe(true);
    expect(has("apps/web/node_modules/pkg/index.js")).toBe(true);
    expect(has("dist/node_modules/inner/index.js")).toBe(true);
    expect(has(".claude/settings.json")).toBe(true);
    expect(has(".env")).toBe(true);
    expect(has("notes-by-agent.md")).toBe(true);
    expect(has("src/app.ts")).toBe(true);
    expect(counts.files).toBe(4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/removed 4 ignored files and \d+ directories/);
    expect(lines[0]).not.toContain("apps");
  });

  it("keeps the sandbox stubs the workspace's own exclude block hides", async () => {
    writeWorkspaceExclude(ws, ["src/app.ts"]);
    put(".gitconfig", "");
    put(".vscode/x", "");
    put(".npmrc", "");
    put("build/out.js");
    sh("-C", ws, "status", "--ignored", "--short"); // git sees the stubs as ignored
    await clean(git(), ws);
    expect(has(".gitconfig")).toBe(true);
    expect(has(".vscode/x")).toBe(true);
    expect(has(".npmrc")).toBe(true);
  });

  it("removes a symlink inside an ignored directory without touching its target", async () => {
    put("dist/real.js");
    writeFileSync(path.join(outside, "precious.txt"), "keep me");
    symlinkSync(outside, path.join(ws, "dist", "escape"));
    symlinkSync(path.join(outside, "precious.txt"), path.join(ws, "dist", "file-link"));
    symlinkSync(outside, path.join(ws, "link")); // an ignored top-level link
    await clean(git(), ws);
    expect(has("dist")).toBe(false);
    expect(has("link")).toBe(false);
    expect(readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });

  it("never deletes through a directory-named link out of the workspace", async () => {
    writeFileSync(path.join(outside, "precious.txt"), "keep me");
    symlinkSync(outside, path.join(ws, "dist"));
    await clean(git(), ws);
    expect(existsSync(path.join(outside, "precious.txt"))).toBe(true);
    expect(has("dist")).toBe(true); // `dist/` does not match a link, so git calls it untracked, not ignored: left as is
  });

  it("leaves a workspace alone when git cannot answer", async () => {
    const plain = path.join(root, "not-a-repo");
    mkdirSync(path.join(plain, "dist"), { recursive: true });
    writeFileSync(path.join(plain, "dist", "a.js"), "x");
    const counts = await clean(git(), plain);
    expect(counts).toEqual({ files: 0, dirs: 0 });
    expect(existsSync(path.join(plain, "dist", "a.js"))).toBe(true);
  });

  it("cleans a stale directory that sorts after more than 64 K of listing, and says so when the listing stays cut off", async () => {
    const dirs = Array.from({ length: 3000 }, (_, n) => `src/pkg${String(n).padStart(5, "0")}/lib`);
    for (const dir of dirs) {
      put(`${dir}/keep.ts`, "tracked"); // a tracked sibling: the folder never collapses into one entry
      put(`${dir}/index.gen.js`, "generated");
    }
    writeFileSync(path.join(ws, ".gitignore"), "*.gen.js\n.next/\nnode_modules/\n");
    sh("-C", ws, "add", "-A", ":!**/*.gen.js");
    sh("-C", ws, "commit", "-q", "-m", "many");
    put("zz/web/.next/server/page.js");
    const lines: string[] = [];
    const counts = await clean(git(), ws, (line) => lines.push(line));
    expect(has("zz/web/.next")).toBe(false);
    expect(has(`${dirs[2999]}/index.gen.js`)).toBe(false);
    expect(has(`${dirs[0]}/keep.ts`)).toBe(true);
    expect(counts.files).toBeGreaterThanOrEqual(3001);
    expect(lines.some((line) => /cut off/.test(line))).toBe(false);
    // A listing that stays at the cap while a pass removes nothing (kept entries only) ends the passes and says so, counts only.
    put("again/node_modules/p.js");
    const cut: string[] = [];
    await clean(git(), ws, (line) => cut.push(line), 1);
    expect(cut.some((line) => /cut off/.test(line))).toBe(true);
    expect(cut.join("\n")).not.toContain("again");
  });

  it("keeps a nested repository's working tree, nested .claude, CLAUDE.local.md, .envrc and .venv", async () => {
    writeFileSync(path.join(ws, ".gitignore"), ".next/\nvend/\n*.local.md\n.envrc\n.venv/\n.claude/\n");
    sh("-C", ws, "add", ".gitignore");
    sh("-C", ws, "commit", "-q", "-m", "ignores");
    mkdirSync(path.join(ws, "vend", "lib"), { recursive: true });
    sh("-C", path.join(ws, "vend", "lib"), "init", "-q");
    put("vend/lib/work.txt", "uncommitted work");
    put("vend/build.log", "stale");
    put("apps/web/.claude/settings.local.json");
    put("CLAUDE.local.md");
    put("pkg/.envrc");
    put("tools/.venv/bin/python");
    put("apps/web/.next/x.js");
    await clean(git(), ws);
    expect(has("vend/lib/work.txt")).toBe(true);
    expect(has("vend/lib/.git")).toBe(true);
    expect(has("vend/build.log")).toBe(false); // only the directory with the repository is kept whole; its stale sibling goes
    expect(has("apps/web/.claude/settings.local.json")).toBe(true);
    expect(has("CLAUDE.local.md")).toBe(true);
    expect(has("pkg/.envrc")).toBe(true);
    expect(has("tools/.venv/bin/python")).toBe(true);
    expect(has("apps/web/.next")).toBe(false);
  });

  it("does nothing on darwin except say so, and cleans on linux", async () => {
    put("dist/a.js");
    const lines: string[] = [];
    const counts = await clean(git(), ws, (line) => lines.push(line), undefined, "darwin");
    expect(counts).toEqual({ files: 0, dirs: 0 });
    expect(has("dist/a.js")).toBe(true);
    expect(lines).toEqual(["fx-runner: resume clean-up skipped on macOS"]);
    await clean(git(), ws, undefined, undefined, "linux");
    expect(has("dist")).toBe(false);
  });
});
