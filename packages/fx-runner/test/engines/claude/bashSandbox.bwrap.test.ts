import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    const attempts = ["echo x > .git/hooks/pre-commit", "echo x >> .git/config", "echo x > .git/hooks/new", "echo x >> .env", ...SANDBOX_PROTECTED_FILES.map((name) => `echo x >> ${name}`)];
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
