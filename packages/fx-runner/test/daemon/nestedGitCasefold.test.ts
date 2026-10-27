import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoOutsideGitfiles, isDotGitName } from "../../src/daemon/nestedGitfiles.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#6 RUNNER-HOSTREAD-FOLLOWUPS-527 (CWE-178): git reads `.GIT` as `.git` on a case-insensitive filesystem (macOS by default), and by its own name rules also the HFS+ ignorable
 * code points, NTFS trailing dots and spaces, a stream suffix and `git~1`. The walk must refuse every one of them.
 */
const IN_NAMESPACE = process.env["FX_CASEFOLD_DIR"];

describe("isDotGitName", () => {
  it("matches every spelling git reads as .git", () => {
    for (const name of [".git", ".GIT", ".Git", ".gIt", ".g‌it", ".‏git", ".gi‪t", ".git⁯", "﻿.git", "git~1", "GIT~1", ".git.", ".git ", ".git. .", ".git::$INDEX_ALLOCATION", ".git:stream", ".git\ufffe", ".git\uffff", ".git\ufffe:x", ".git\uffff:x"]) {
      expect(isDotGitName(name), JSON.stringify(name)).toBe(true);
    }
  });
  it("does not match other names", () => {
    for (const name of [".gitignore", ".gitattributes", ".github", "git", "gitx", "x.git", ".gi", "git~2", ".git-x", "dot.git.txt", ""]) expect(isDotGitName(name), name).toBe(false);
  });
});

describe.skipIf(IN_NAMESPACE !== undefined)("the walk on a case-insensitive filesystem", () => {
  it("(outer) runs the checks below inside a user and mount namespace with a casefold tmpfs, when the host allows one", () => {
    const dir = mkdtempSync(path.join(tmpRoot(), "fxr-casefold-"));
    try {
      const script = path.join(dir, "run.sh");
      const mount = path.join(dir, "cf");
      mkdirSync(mount);
      const vitest = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
      writeFileSync(script, `set -e\nmount -t tmpfs -o casefold tmpfs "${mount}"\nchattr +F "${mount}"\nexport FX_CASEFOLD_DIR="${mount}"\nexec node "${vitest}" run test/daemon/nestedGitCasefold.test.ts\n`);
      const probe = spawnSync("unshare", ["-rm", "true"], { encoding: "utf8" });
      if (probe.status !== 0) {
        console.warn("casefold integration test skipped: no user and mount namespace on this host (the name function is still unit tested above)");
        return;
      }
      const run = spawnSync("unshare", ["-rm", "sh", script], { encoding: "utf8", cwd: path.join(__dirname, "..", ".."), env: { ...process.env } });
      if (run.status !== 0 && /casefold|Invalid argument|chattr|not supported/i.test(`${run.stdout}${run.stderr}`) && !/FAIL|AssertionError/.test(`${run.stdout}${run.stderr}`)) {
        console.warn("casefold integration test skipped: this kernel has no casefold tmpfs");
        return;
      }
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(IN_NAMESPACE === undefined)("(inner) on a real casefold directory", () => {
  const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: { PATH: process.env["PATH"] ?? "", HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.test" }, encoding: "utf8" });

  it("control: the filesystem folds case and the host's git reads a .GIT gitfile as .git; the walk refuses it, and a .GIT repository with a /dev/zero ref", () => {
    const base = path.join(IN_NAMESPACE!, "t");
    mkdirSync(base);
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    sh(outside, "init", "-q", "-b", "main");
    const ws = path.join(base, "ws");
    mkdirSync(path.join(ws, "sub"), { recursive: true });
    sh(ws, "init", "-q", "-b", "main");
    writeFileSync(path.join(ws, "sub", "f"), "x\n");
    expect(sh(ws, "ls-files", "--others", "--exclude-standard")).toContain("sub/f");
    writeFileSync(path.join(ws, "sub", ".GIT"), `gitdir: ${path.join(outside, ".git")}\n`);
    expect(sh(ws, "ls-files", "--others", "--exclude-standard")).not.toContain("sub/f"); // git took .GIT for .git: the oracle is real here
    expect(() => assertNoOutsideGitfiles(ws)).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
    rmSync(path.join(ws, "sub", ".GIT"));
    expect(() => assertNoOutsideGitfiles(ws)).not.toThrow();
    const nested = path.join(ws, "sub2");
    mkdirSync(nested);
    sh(nested, "init", "-q", "-b", "main");
    renameSync(path.join(nested, ".git"), path.join(nested, "moved"));
    renameSync(path.join(nested, "moved"), path.join(nested, ".GIT"));
    symlinkSync("/dev/zero", path.join(nested, ".GIT", "refs", "heads", "zero"));
    expect(() => assertNoOutsideGitfiles(ws)).toThrow(expect.objectContaining({ code: "workspace_git_refused" }));
  });
});
