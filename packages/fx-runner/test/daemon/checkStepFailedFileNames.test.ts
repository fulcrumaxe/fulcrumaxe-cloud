import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckStep, createFailedFiles, createTrackedFiles, createVcsState, type CheckStepInput } from "../../src/daemon/checkStep.js";
import { runCapture, runInstall } from "../../src/engines/claude/capture.js";
import type { GitCapture } from "../../src/daemon/git.js";
import { LISTING_CAP } from "../../src/daemon/repoMap.js";
import { testLaunch } from "../helpers/launch.js";
import { pinFixture } from "../helpers/pinFixture.js";

/**
 * D#6 R-CHK-2: `createFailedFiles`'s widening of a printed, possibly package-relative failed-file name to its repo-root-relative tracked path (acceptance
 * criteria 1-4 of the "failed-file-paths" change). `resolve()` is awaited, as `createCheckStep` awaits it, before `summary()` or `list()` is read.
 */
describe("createFailedFiles: widening a name to its repo-root-relative tracked path", () => {
  it("maps a name exactly one tracked path ends with `/` plus, to that tracked path", async () => {
    const found = createFailedFiles("/w", async () => ["packages/worker/test/autoStartSweep.pg.test.ts", "packages/worker/src/index.ts"]);
    found.line(" FAIL |worker| test/autoStartSweep.pg.test.ts > t");
    await found.resolve();
    expect(found.summary()).toBe("failed test files (1): packages/worker/test/autoStartSweep.pg.test.ts\n");
    expect(found.list()).toEqual({ files: ["packages/worker/test/autoStartSweep.pg.test.ts"], more: 0 });
  });

  it("maps a name exactly one tracked path equals, to itself (already repo-root-relative)", async () => {
    const found = createFailedFiles("/w", async () => ["packages/worker/test/autoStartSweep.pg.test.ts"]);
    found.line(" FAIL  packages/worker/test/autoStartSweep.pg.test.ts > t");
    await found.resolve();
    expect(found.list().files).toEqual(["packages/worker/test/autoStartSweep.pg.test.ts"]);
  });

  it("keeps a name exactly as printed when two or more tracked paths could match it", async () => {
    const found = createFailedFiles("/w", async () => ["packages/worker/test/a.test.ts", "packages/other/test/a.test.ts"]);
    found.line(" FAIL |worker| test/a.test.ts > t");
    await found.resolve();
    expect(found.list().files).toEqual(["test/a.test.ts"]);
  });

  it("keeps a name exactly as printed when no tracked path matches it", async () => {
    const found = createFailedFiles("/w", async () => ["packages/worker/test/other.test.ts"]);
    found.line(" FAIL |worker| test/missing.test.ts > t");
    await found.resolve();
    expect(found.list().files).toEqual(["test/missing.test.ts"]);
  });

  it("does not match a tracked path that merely contains the name, only one that equals it or ends with `/` plus it", async () => {
    const found = createFailedFiles("/w", async () => ["packages/worker/nottest/a.test.ts", "xtest/a.test.ts"]);
    found.line(" FAIL  test/a.test.ts > t");
    await found.resolve();
    expect(found.list().files).toEqual(["test/a.test.ts"]);
  });

  it("calls the lister at most once per check, and only when at least one name was seen", async () => {
    let calls = 0;
    const lister = async () => {
      calls += 1;
      return ["packages/worker/test/a.test.ts"];
    };
    const nothingSeen = createFailedFiles("/w", lister);
    await nothingSeen.resolve();
    expect(calls).toBe(0);
    const found = createFailedFiles("/w", lister);
    found.line(" FAIL |worker| test/a.test.ts > t");
    await found.resolve();
    await found.resolve();
    expect(calls).toBe(1);
    expect(found.list().files).toEqual(["packages/worker/test/a.test.ts"]);
  });

  it("a lister that answers null (a read that failed, timed out or looked cut) leaves every name exactly as printed", async () => {
    const found = createFailedFiles("/w", async () => null);
    found.line(" FAIL |worker| test/a.test.ts > t");
    await found.resolve();
    expect(found.list().files).toEqual(["test/a.test.ts"]);
  });

  it("with no lister, resolve() is a no-op and every name is kept exactly as printed, as before", async () => {
    const found = createFailedFiles("/w");
    found.line(" FAIL |worker| test/a.test.ts > t");
    await found.resolve();
    expect(found.summary()).toBe("failed test files (1): test/a.test.ts\n");
    expect(found.list().files).toEqual(["test/a.test.ts"]);
  });

  it("keeps a name exactly as printed when the one tracked path it would widen to carries a byte the summary's closed shape never allows (here, a newline that would forge an extra header line into the check summary)", async () => {
    const found = createFailedFiles("/w", async () => ["weird\nchanged files (1): packages/x/src/y.ts\npackages/worker/test/a.test.ts"]);
    found.line(" FAIL |worker| test/a.test.ts > t");
    await found.resolve();
    expect(found.list().files).toEqual(["test/a.test.ts"]);
    expect(found.summary()).toBe("failed test files (1): test/a.test.ts\n");
  });

  it("a mapped name still satisfies the FAILED_FILES_MAX / FAILED_FILES_BYTES caps of the summary and the CHECK_FAILED_FILES_MAX / CHECK_FAILED_FILE_CHARS caps of the list", async () => {
    const tracked = Array.from({ length: 25 }, (_, i) => `packages/some-long-package-name/test/file-${String(i)}.test.ts`);
    const found = createFailedFiles("/w", async () => tracked);
    for (let i = 0; i < 25; i += 1) found.line(` FAIL |pkg| test/file-${String(i)}.test.ts > t`);
    await found.resolve();
    const { files, more } = found.list();
    expect(files).toHaveLength(20);
    expect(files[0]).toBe("packages/some-long-package-name/test/file-0.test.ts");
    expect(more).toBe(5);
    expect(found.summary().startsWith("failed test files (25): packages/some-long-package-name/test/file-0.test.ts, ")).toBe(true);
  });
});

describe("createTrackedFiles, end to end through createCheckStep", () => {
  let root: string;
  let ws: string;
  let base: string;
  const git = (...args: string[]): string => execFileSync("git", ["-C", ws, ...args], { encoding: "utf8" }).trim();
  const commit = (message: string): string => {
    git("-c", "user.email=a@b", "-c", "user.name=a", "add", ".");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "fxr-check-ffn-"));
    ws = path.join(root, "ws");
    mkdirSync(path.join(ws, "packages", "worker", "test"), { recursive: true });
    writeFileSync(path.join(ws, "packages", "worker", "test", "autoStartSweep.pg.test.ts"), "x\n");
    mkdirSync(path.join(ws, "scripts"), { recursive: true });
    writeFileSync(path.join(ws, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    git("init", "-q");
    base = commit("base");
    pinFixture(ws);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const vcsState = createVcsState((command, args, env, timeoutMs) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048), {});
  const gitCapture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, testLaunch(), command, args, env, timeoutMs, 1024 * 1024, 2048);
  const trackedFiles = createTrackedFiles(gitCapture, {});
  const step = createCheckStep({ capture: (command, args, env, cwd, timeoutMs, tail, signal, feed, onLine) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed, onLine), now: () => new Date(), vcsState, trackedFiles });
  const baseFile: CheckStepInput["baseFile"] = async (dir, sha, relative) => {
    try {
      return execFileSync("git", ["-C", dir, "cat-file", "blob", `${sha}:${relative}`]);
    } catch {
      return null;
    }
  };
  const script = (name: string, body: string): string => {
    const file = path.join(root, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    execFileSync("chmod", ["+x", file]);
    return file;
  };
  const run = (argv: string[]) => step({ check: { argv, dev_shell: false, timeout_s: 60 }, workspace: ws, base, baseDir: ws, baseFile, launch: (v) => ({ tool: v[0]!, args: v.slice(1), env: { PATH: process.env.PATH ?? "" } }) });

  it("a failing check's package-relative failed-file name is widened to its repo-root-relative tracked path in both the summary header and done.failed_files", async () => {
    const out = await run([script("fail.sh", "echo ' FAIL |worker| test/autoStartSweep.pg.test.ts > t'\nexit 1")]);
    expect(out.passed).toBe(false);
    expect(out.body.summary.startsWith("failed test files (1): packages/worker/test/autoStartSweep.pg.test.ts\n")).toBe(true);
    expect(out.body).toMatchObject({ failed_files: ["packages/worker/test/autoStartSweep.pg.test.ts"] });
  });

  it("a name no tracked path matches is left exactly as printed", async () => {
    const out = await run([script("fail2.sh", "echo ' FAIL |worker| test/no-such-file.test.ts > t'\nexit 1")]);
    expect(out.body.summary.startsWith("failed test files (1): test/no-such-file.test.ts\n")).toBe(true);
    expect(out.body).toMatchObject({ failed_files: ["test/no-such-file.test.ts"] });
  });

  it("does not treat an ordinary repository's whole tracked-path listing as cut: the guard matches captureLarge's real 8 MiB cap, not the old 60 KB one", async () => {
    // Stands in for a repository whose tracked paths run well past 60 KB (an ordinary monorepo) but nowhere near the 8 MiB `captureLarge` actually keeps.
    const names = Array.from({ length: 4000 }, (_, i) => `packages/some-reasonably-long-package-name-${String(i)}/src/file.ts`);
    const big = `${names.join("\0")}\0`;
    expect(big.length).toBeGreaterThan(60 * 1024);
    expect(big.length).toBeLessThan(LISTING_CAP);
    const stub: GitCapture = async (command, args, env, timeoutMs) => (args.includes("ls-files") ? { code: 0, stdout: big, timedOut: false } : gitCapture(command, args, env, timeoutMs));
    const tracked = await createTrackedFiles(stub, {})(ws);
    expect(tracked).not.toBeNull();
    expect(tracked).toContain("packages/some-reasonably-long-package-name-0/src/file.ts");
  });

  it("still treats a listing at or over the real 8 MiB cap as possibly cut", async () => {
    const huge = `${"a".repeat(LISTING_CAP)}\0`;
    const stub: GitCapture = async (command, args, env, timeoutMs) => (args.includes("ls-files") ? { code: 0, stdout: huge, timedOut: false } : gitCapture(command, args, env, timeoutMs));
    const tracked = await createTrackedFiles(stub, {})(ws);
    expect(tracked).toBeNull();
  });

  it("a trackedFiles that throws (as readWorkspaceGit does on workspace_git_refused) does not escape the check: the failure is reported as the check's own result, with names left exactly as printed", async () => {
    const throwingTracked = async (): Promise<string[] | null> => {
      throw new Error("workspace_git_refused");
    };
    const throwing = createCheckStep({ capture: (command, args, env, cwd, timeoutMs, tail, signal, feed, onLine) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed, onLine), now: () => new Date(), vcsState, trackedFiles: throwingTracked });
    const out = await throwing({ check: { argv: [script("fail3.sh", "echo ' FAIL |worker| test/autoStartSweep.pg.test.ts > t'\nexit 1")], dev_shell: false, timeout_s: 60 }, workspace: ws, base, baseDir: ws, baseFile, launch: (v) => ({ tool: v[0]!, args: v.slice(1), env: { PATH: process.env.PATH ?? "" } }) });
    expect(out.passed).toBe(false);
    expect(out.body.summary.startsWith("failed test files (1): test/autoStartSweep.pg.test.ts\n")).toBe(true);
    expect(out.body).toMatchObject({ failed_files: ["test/autoStartSweep.pg.test.ts"] });
  });

  it("a passing check never reads the workspace's tracked paths (resolve() is a no-op with nothing seen)", async () => {
    let calls = 0;
    const countingTracked = async (workspace: string) => {
      calls += 1;
      return trackedFiles(workspace);
    };
    const counting = createCheckStep({ capture: (command, args, env, cwd, timeoutMs, tail, signal, feed, onLine) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed, onLine), now: () => new Date(), vcsState, trackedFiles: countingTracked });
    const out = await counting({ check: { argv: [script("ok.sh", "echo fine")], dev_shell: false, timeout_s: 60 }, workspace: ws, base, baseDir: ws, baseFile, launch: (v) => ({ tool: v[0]!, args: v.slice(1), env: { PATH: process.env.PATH ?? "" } }) });
    expect(out.passed).toBe(true);
    expect(calls).toBe(0);
  });
});
