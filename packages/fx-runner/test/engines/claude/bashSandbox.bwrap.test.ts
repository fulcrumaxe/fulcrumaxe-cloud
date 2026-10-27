import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChangedFiles, createVcsState } from "../../../src/daemon/checkStep.js";
import { configEnv, guardConfigEnv, type Git, type GitCapture } from "../../../src/daemon/git.js";
import { pinWorkspaceGit } from "../../../src/daemon/hostRead.js";
import { bashSandboxArgs, bashSandboxUnusable, editDeniedPaths } from "../../../src/engines/claude/bashSandboxProbe.js";
import { settingsFor } from "../../../src/engines/claude/settingsFile.js";
import { SANDBOX_PROTECTED_FILES } from "../../../src/daemon/sandboxStubs.js";
import { protectedPaths } from "../../../src/sandbox/sandboxSettings.js";
import { bwrapCanCreateNamespaces } from "../../helpers/bwrapProbe.js";
import { tmpRoot } from "../../helpers/tmpRoot.js";

/**
 * Hotfix for the Bash outage after the `.git` deny rules: the CLI's shell sandbox turns each `Edit` deny rule into a read-only bind, and a read-only
 * `.git` leaves no room for the placeholder it makes at `.git/config.lock`, so every Bash call died with "bwrap: Can't create file ... Read-only file system".
 * These tests build a real executor's settings file, translate it to bubblewrap the way the CLI does (`bashSandboxArgs`), and run real commands in a real git
 * workspace. The first test is the regression: the rules that shipped must fail here, and the current ones must pass.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);

let root: string;
const SANDBOX = { enabled: true, filesystem: { denyRead: ["~"] } };

/** A fresh git workspace with one commit (the CLI's placeholders are made in it by the first bubblewrap run, so each scenario gets its own). */
function newWorkspace(name: string): string {
  const ws = path.join(root, name);
  mkdirSync(ws, { recursive: true });
  const git = (...args: string[]): void => void execFileSync("git", ["-C", ws, "-c", "user.email=a@b", "-c", "user.name=a", ...args], { stdio: "ignore" });
  writeFileSync(path.join(ws, "README"), "x\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return ws;
}

const settingsOf = (ws: string) => JSON.parse(JSON.stringify(settingsFor("executor", SANDBOX, ws, protectedPaths({ home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin") })))) as { permissions: { deny: string[] } };

/** The rules that shipped in the regression: the whole `.git` folder and everything under it. */
function shippedSettings(ws: string) {
  const fixed = settingsOf(ws);
  const keep = fixed.permissions.deny.filter((rule) => !rule.includes("/.git/"));
  return { permissions: { deny: [...keep, `Edit(/${ws}/.git)`, `Edit(/${ws}/.git/**)`] } };
}

/** The probe's process runner, a real one here so the probe is exercised against the real bubblewrap. */
const runReal = async (file: string, args: readonly string[]) => {
  const run = spawnSync(file, [...args], { encoding: "utf8", timeout: 20_000 });
  return { code: run.status, stderr: run.stderr };
};

function underBwrap(settings: { permissions?: { deny?: unknown } }, ws: string, command: string): { code: number | null; out: string } {
  const run = spawnSync(BWRAP as string, [...bashSandboxArgs(settings, ws, ws), "--chdir", ws, "--", "sh", "-c", command], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env["PATH"] ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

describe.skipIf(!usable)("the agent's Bash starts under the job's own file rules (real bubblewrap, real git workspace)", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpRoot(), "bwrapfix-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("control: the rules that shipped (deny on the whole .git folder) kill Bash before the command starts", () => {
    const ws = newWorkspace("shipped");
    const result = underBwrap(shippedSettings(ws), ws, "true");
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/bwrap: Can't create file .*\.git\/config\.lock: Read-only file system/);
  });

  it("the job's real rules: `true` and `git status` run and exit 0", () => {
    const ws = newWorkspace("fixed");
    const settings = settingsOf(ws);
    expect(underBwrap(settings, ws, "true")).toMatchObject({ code: 0 });
    const status = underBwrap(settings, ws, "git status --porcelain");
    expect(status.code, status.out).toBe(0);
  });

  it("with the config.worktree file bind in place, true, git status, and branch plus commit still pass, and the file is read-only", () => {
    const ws = newWorkspace("shape-binds");
    const settings = settingsOf(ws);
    expect(underBwrap(settings, ws, "true")).toMatchObject({ code: 0 });
    const status = underBwrap(settings, ws, "git status --porcelain");
    expect(status.code, status.out).toBe(0);
    const commit = underBwrap(settings, ws, "echo y > g && git checkout -q -b shape && git add g && git -c user.email=a@b -c user.name=a commit -q -m shape && git log --oneline | wc -l");
    expect(commit.code, commit.out).toBe(0);
    for (const file of ["config.worktree"]) {
      for (const attempt of [`echo ../elsewhere > .git/${file}`, `rm -f .git/${file}`, `mv .git/${file} .git/${file}.old`]) {
        const result = underBwrap(settings, ws, attempt);
        expect(result.code, attempt).not.toBe(0);
      }
    }
  });

  it("control: a deny on .git/commondir is NOT usable (the bind leaves an empty commondir and git refuses to start), so that file is guarded by the host-side shape check instead", () => {
    const ws = newWorkspace("commondir-control");
    const settings = settingsOf(ws);
    const withCommondir = { permissions: { deny: [...settings.permissions.deny, `Edit(/${ws}/.git/commondir)`] } };
    expect(underBwrap(withCommondir, ws, "true")).toMatchObject({ code: 0 });
    const status = underBwrap(withCommondir, ws, "git status --porcelain");
    expect(status.code).not.toBe(0);
    expect(editDeniedPaths(settings)).not.toContain(path.join(ws, ".git/commondir"));
  });

  it("the whole .git swap inside ONE Bash call (new .git, config of its own, a clean filter, core.worktree) is refused by the host read: no program runs, no outside folder is listed", async () => {
    const source = newWorkspace("swap-src");
    const ws = path.join(root, "swap-ws");
    const env = { PATH: process.env["PATH"] ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["clone", "-q", "--reference", path.join(source, ".git"), "--no-local", "--", source, ws], { env });
    const realGit: Git = { async run(_code, args, config, _timeout, extraEnv) { return execFileSync("git", [...args], { env: { ...env, ...(config === undefined ? guardConfigEnv() : configEnv(config)), ...extraEnv }, encoding: "utf8" }); } };
    await pinWorkspaceGit(realGit, ws, path.join(source, ".git", "objects"));
    const base = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
    const marker = path.join(root, "swap-marker");
    const outside = path.join(root, "swap-outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "s\n");
    const settings = settingsOf(ws);
    underBwrap(settings, ws, "true"); // the CLI's placeholders, as in a real run
    // All in one call: the new folder is writable until the call ends, so its config can be written.
    const swap = [
      "mv .git .gitold", "mkdir .git", "cp -r .gitold/HEAD .gitold/refs .gitold/objects .gitold/index .gitold/config .git/",
      `git config filter.x.clean 'touch ${marker}; cat'`, `git config core.worktree ${outside}`, "mkdir -p .git/info", "echo '* filter=x' > .git/info/attributes", "echo changed >> README",
    ].join(" && ");
    const result = underBwrap(settings, ws, swap);
    expect(result.code, result.out).toBe(0);
    // Control: an unchecked host read of the swapped folder really starts the agent's program (with core.worktree dropped so the diff reaches the changed file).
    execFileSync("git", ["-C", ws, "config", "--unset", "core.worktree"], { env });
    execFileSync("git", ["-C", ws, "diff", "--name-only", base, "--"], { env, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    execFileSync("git", ["-C", ws, "config", "core.worktree", outside], { env });
    const calls: string[][] = [];
    const capture: GitCapture = async (_command, args) => (calls.push([...args]), { code: 0, stdout: "", timedOut: false });
    await expect(createChangedFiles(capture, {} as never)(ws, base)).rejects.toMatchObject({ code: "workspace_git_refused" });
    await expect(createVcsState(capture, {} as never)(ws)).rejects.toMatchObject({ code: "workspace_git_refused" });
    expect(calls).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("a nested repository with a clean filter, committed as a gitlink and dirtied inside ONE Bash call, starts no program on the host read", async () => {
    const source = newWorkspace("nested-src");
    const ws = path.join(root, "nested-ws");
    const env = { PATH: process.env["PATH"] ?? "", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["clone", "-q", "--reference", path.join(source, ".git"), "--no-local", "--", source, ws], { env });
    const realGit: Git = { async run(_code, args, config, _timeout, extraEnv) { return execFileSync("git", [...args], { env: { ...env, ...(config === undefined ? guardConfigEnv() : configEnv(config)), ...extraEnv }, encoding: "utf8" }); } };
    await pinWorkspaceGit(realGit, ws, path.join(source, ".git", "objects"));
    const marker = path.join(root, "nested-marker");
    const settings = settingsOf(ws);
    underBwrap(settings, ws, "true");
    const id = "-c user.email=a@b -c user.name=a";
    const attack = [
      "mkdir sub", "cd sub", "git init -q -b main", "echo one > f", "echo '* filter=x' > .gitattributes", "git add .", `git ${id} commit -q -m inner`,
      `git config filter.x.clean 'touch ${marker}; cat'`, "cd ..", "git add sub", `git ${id} commit -q -m gitlink`, "echo two > sub/f",
    ].join(" && ");
    const result = underBwrap(settings, ws, attack);
    expect(result.code, result.out).toBe(0);
    const base = execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
    execFileSync("git", ["-C", ws, "diff", "--name-only", base, "--"], { env, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true); // control: an unguarded host diff starts the nested repository's filter
    rmSync(marker);
    const capture: GitCapture = (command, args, e, timeoutMs) =>
      new Promise((resolve) => {
        const run = spawnSync(command, [...args], { env: e, timeout: timeoutMs, encoding: "utf8" });
        resolve({ code: run.status, stdout: run.stdout, timedOut: false });
      });
    const listed = await createChangedFiles(capture, {} as never)(ws, base);
    expect(listed).not.toContain("sub/f");
    await createVcsState(capture, {} as never)(ws);
    expect(existsSync(marker)).toBe(false);
  });

  it("the agent can still commit, branch and add files (the index, objects and refs stay writable)", () => {
    const ws = newWorkspace("commit");
    const settings = settingsOf(ws);
    const result = underBwrap(settings, ws, "echo y > f && git checkout -q -b work && git add f && git -c user.email=a@b -c user.name=a commit -q -m work && git log --oneline | wc -l");
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("2");
  });

  it("the shell cannot change what the rules protect: hooks, the git config, lockfiles, shell start-up files and .env stay read-only", () => {
    const ws = newWorkspace("protected");
    writeFileSync(path.join(ws, ".env"), "A=1\n");
    const settings = settingsOf(ws);
    underBwrap(settings, ws, "true"); // makes the placeholders, as the CLI does
    const attempts = ["echo x > .git/hooks/pre-commit", "echo x >> .git/config", "echo x > .git/config.worktree", "echo x > .git/hooks/new", "echo x >> .env", ...SANDBOX_PROTECTED_FILES.map((name) => `echo x >> ${name}`)];
    for (const attempt of attempts) {
      const result = underBwrap(settings, ws, attempt);
      expect(result.code, attempt).not.toBe(0);
      expect(result.out, attempt).toMatch(/Read-only file system|Permission denied/);
    }
  });

  it("every deny rule naming one path inside the workspace is one of the bind targets, and no rule names the whole .git folder", () => {
    const ws = newWorkspace("rules");
    const paths = editDeniedPaths(settingsOf(ws));
    expect(paths).toContain(path.join(ws, ".git/hooks"));
    expect(paths).toContain(path.join(ws, ".git/config"));
    expect(paths).toContain(path.join(ws, ".git/config.worktree"));
    expect(paths).not.toContain(path.join(ws, ".git"));
    for (const name of SANDBOX_PROTECTED_FILES) expect(paths).toContain(path.join(ws, name));
  });

  it("the start-up probe agrees: it flags the shipped rules and passes the current ones, without leaving a placeholder in the workspace", async () => {
    const ws = newWorkspace("probe");
    const scratch = path.join(root, "probe-scratch");
    const env = { PATH: process.env["PATH"] ?? "" };
    expect(await bashSandboxUnusable(shippedSettings(ws), ws, env, scratch, runReal)).toBe(true);
    expect(await bashSandboxUnusable(settingsOf(ws), ws, env, scratch, runReal)).toBe(false);
    expect(existsSync(path.join(ws, ".git", "config.lock"))).toBe(false);
  });
});


describe("the start-up probe judgement of what it sees", () => {
  const settings = { permissions: { deny: [] as string[] } };
  const scratch = path.join(tmpRoot(), "bwrapfix-probe-unit");
  const withBwrap = BWRAP === undefined ? { PATH: "" } : { PATH: path.dirname(BWRAP) };

  it.skipIf(BWRAP === undefined)("only a bubblewrap error is an unusable sandbox; any other failure, or a run that could not start, is not", async () => {
    const judged = (out: { code: number | null; stderr?: string }) => bashSandboxUnusable(settings, "/ws", withBwrap, scratch, async () => out);
    expect(await judged({ code: 1, stderr: "bwrap: Cannot create file x: Read-only file system" })).toBe(true);
    expect(await judged({ code: 1, stderr: "some other failure" })).toBe(false);
    expect(await judged({ code: null })).toBe(false);
    expect(await judged({ code: 0, stderr: "bwrap: warning only" })).toBe(false);
    expect(existsSync(scratch)).toBe(false);
  });

  it("a machine with no bubblewrap on the agent PATH (macOS) is never judged", async () => {
    expect(await bashSandboxUnusable(settings, "/ws", { PATH: "/nonexistent-dir" }, scratch, async () => ({ code: 1, stderr: "bwrap: x" }))).toBe(false);
  });
});
