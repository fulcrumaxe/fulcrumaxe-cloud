import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNNER_ELIGIBLE_ROLES } from "@fulcrumaxe/runner-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCapture } from "../src/engines/claude/capture.js";
import { confineFileTools, denyRules } from "../src/engines/claude/filePermissions.js";
import { settingsFor } from "../src/engines/claude/settingsFile.js";
import { createGitPath, PUSHING_ROLES, type GitJob } from "../src/daemon/gitPath.js";
import { roleToolsFor } from "../src/job/roleTools.js";
import { bwrapArgs } from "../src/sandbox/probe.js";
import { assertEnabledSandbox, protectedPaths, sandboxSettings, MODEL_HOST } from "../src/sandbox/sandboxSettings.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * C44-5 (owner ruling R-C44-1): the executor and the four review roles hold plain `Bash`. The OS sandbox is then the only boundary on what a shell command
 * can do, so these tests prove the boundary still holds with plain Bash: the sandbox block is still required to be strict, the settings still carry
 * dontAsk and the protected-path denies, home stays unreadable, writes outside the job stay refused, and a reviewer's work is never published.
 * Every file below lives in a throwaway directory made with mkdtemp; nothing reads or writes the real home directory.
 */
const PLAIN_BASH_ROLES = ["executor", "code-reviewer", "security-reviewer", "acceptance-tester", "debater"] as const;
const REVIEW_ROLES = PLAIN_BASH_ROLES.filter((role) => role !== "executor");
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

let root: string;
let home: string;
let workspace: string;
let tempDir: string;
const input = () => ({ workspace, tempDir, home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(root, "bin"), workspaceRoot: path.dirname(workspace), tempRoot: path.dirname(tempDir) });

beforeAll(() => {
  root = mkdtempSync(path.join(tmpRoot(), "c445-"));
  home = path.join(root, "home");
  workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
  tempDir = path.join(home, ".cache", "fx-runner", "tmp", "rn-1");
  for (const dir of [workspace, tempDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("C44-5: plain Bash in the role tables", () => {
  it("the five roles hold Bash and no Bash( prefix entry; the reviewers hold no edit or write tool", () => {
    for (const role of PLAIN_BASH_ROLES) {
      const tools = roleToolsFor(role);
      expect(tools, role).toContain("Bash");
      expect(tools.filter((tool) => tool.startsWith("Bash(")), role).toEqual([]);
    }
    for (const role of REVIEW_ROLES) for (const tool of EDIT_TOOLS) expect(roleToolsFor(role), role).not.toContain(tool);
    expect(roleToolsFor("executor")).toEqual(expect.arrayContaining(EDIT_TOOLS));
  });

  it("every other role keeps its look-only prefix list and gets no plain Bash", () => {
    const others = RUNNER_ELIGIBLE_ROLES.filter((role) => !(PLAIN_BASH_ROLES as readonly string[]).includes(role));
    expect(others.length).toBeGreaterThan(0);
    for (const role of others) {
      const tools = roleToolsFor(role);
      expect(tools, role).not.toContain("Bash");
      expect(tools, role).toEqual(["Read", "Glob", "Grep", "LS", "Bash(curl:*)", "Bash(git:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)", "Bash(pwd)"]);
    }
  });
});

describe("C44-5: the boundary around plain Bash is unchanged", () => {
  const protectedList = () => protectedPaths({ home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(root, "bin") });

  it("the settings file for each plain-Bash role keeps dontAsk, the protected-path denies and the read fence, and carries the sandbox block", () => {
    const sandbox = sandboxSettings(input());
    for (const role of PLAIN_BASH_ROLES) {
      const file = settingsFor(role, sandbox, workspace, protectedList()) as { permissions: Record<string, unknown>; sandbox: unknown };
      expect(file.permissions.defaultMode, role).toBe("dontAsk");
      expect(file.permissions.allow, role).toEqual(confineFileTools(roleToolsFor(role), workspace));
      expect(file.permissions.allow as string[], role).toContain("Bash");
      expect(file.permissions.deny, role).toEqual(denyRules(protectedList()));
      expect((file.permissions.deny as string[]).length, role).toBeGreaterThan(0);
      expect(file.permissions.blockReadsOutsideWorkingDirectories, role).toBe(true);
      expect(file.sandbox, role).toBe(sandbox);
    }
  });

  it("the sandbox block is strict: enabled, failIfUnavailable, no unsandboxed fallback, home denied, a strict network allowlist", () => {
    const block = sandboxSettings(input()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(() => assertEnabledSandbox(block)).not.toThrow();
    expect(block.enabled).toBe(true);
    expect(block.failIfUnavailable).toBe(true);
    expect(block.allowUnsandboxedCommands).toBe(false);
    expect(block.autoAllowBashIfSandboxed).toBe(false);
    expect(block.filesystem.denyRead).toContain(home);
    expect(block.network.strictAllowlist).toBe(true);
    expect(block.network.allowedDomains).toEqual([MODEL_HOST]);
  });

  it("assertEnabledSandbox still throws on each relaxation (autoAllowBashIfSandboxed, allowUnsandboxedCommands, failIfUnavailable) and on a disabled or empty block", () => {
    const block = sandboxSettings(input());
    for (const relaxed of [{ autoAllowBashIfSandboxed: true }, { allowUnsandboxedCommands: true }, { failIfUnavailable: false }, { enabled: false }]) {
      expect(() => assertEnabledSandbox({ ...block, ...relaxed }), JSON.stringify(relaxed)).toThrow(TypeError);
    }
    expect(() => assertEnabledSandbox(null)).toThrow(TypeError);
    expect(() => assertEnabledSandbox({})).toThrow(TypeError);
  });
});

const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);

describe.skipIf(!usable)("C44-5: plain Bash inside the real sandbox (bubblewrap, throwaway home)", () => {
  const CANARY = "FX-C445-CANARY-5d41402abc4b2a76b9719d911017c592";
  const TMP_SCRIPT_ENV = () => ({ PATH: "/run/current-system/sw/bin:/usr/bin:/bin", HOME: home, TMPDIR: tempDir });
  function inSandbox(script: string): { code: number | null; stdout: string; stderr: string } {
    const settings = sandboxSettings(input());
    const args = [...bwrapArgs(settings, (target) => existsSync(target) && statSync(target).isDirectory(), (target) => existsSync(target) && statSync(target).isFile()), "--", "/bin/sh", "-c", script];
    const out = spawnSync(BWRAP!, args, { env: TMP_SCRIPT_ENV(), encoding: "utf8", timeout: 20_000 });
    return { code: out.status, stdout: out.stdout, stderr: out.stderr };
  }

  beforeAll(() => {
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    writeFileSync(path.join(home, ".ssh", "id_ed25519"), CANARY);
    writeFileSync(path.join(home, "notes.txt"), CANARY);
  });

  it("bash -c, env, $VAR, a > redirect into the job temp dir, mktemp, chmod and rmdir all succeed", () => {
    const script = `bash -c 'echo inner' && env | grep -q '^PATH=' && V=ok && echo "$V" > ${tempDir}/out.txt && f=$(mktemp) && chmod 600 "$f" && d=$(mktemp -d) && rmdir "$d" && echo "$f"`;
    const out = inSandbox(script);
    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("inner");
    expect(readFileSync(path.join(tempDir, "out.txt"), "utf8").trim()).toBe("ok");
    expect(out.stdout.trim().split("\n").pop()!.startsWith(`${tempDir}/`)).toBe(true);
  });

  it("control: the same shell cannot read the home directory ($HOME/.ssh, a plain file in home) and the canary never appears", () => {
    for (const target of [".ssh/id_ed25519", "notes.txt"]) {
      const out = inSandbox(`cat "$HOME/${target}"`);
      expect(out.code, target).not.toBe(0);
      expect(out.stdout, target).not.toContain(CANARY);
    }
    const listing = inSandbox(`ls -A "$HOME/.ssh"`);
    expect(listing.stdout).not.toContain("id_ed25519");
  });

  it("a write outside the workspace and the job temp dir is refused with a non-zero exit and leaves nothing", () => {
    const outside = path.join(root, "outside.txt");
    const elsewhere = path.join(home, "dropped.txt");
    expect(inSandbox(`echo x > ${outside}`).code).not.toBe(0);
    // Inside the home directory the sandbox may give the command a scratch view, so the exit status is not the signal there: what matters is that nothing reaches the host.
    inSandbox(`echo x > ${elsewhere}`);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(elsewhere)).toBe(false);
    expect(inSandbox(`echo x > ${workspace}/inside.txt`).code).toBe(0);
  });

  it("there is no unsandboxed fallback: the translation unshares the network, so a connection fails rather than running outside", () => {
    const block = sandboxSettings(input()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(block.allowUnsandboxedCommands).toBe(false);
    expect(block.failIfUnavailable).toBe(true);
    const out = inSandbox(`bash -c 'exec 3<>/dev/tcp/93.184.216.34/80' 2>&1`);
    expect(out.code).not.toBe(0);
  });
});

describe("C44-5: a reviewer's work is never published", () => {
  const sh = (...args: string[]): string =>
    execFileSync("git", args, { env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const lease = { runId: "0b1b6c52-7a43-4d5e-8a77-0f0f0f0f0f0f", leaseGeneration: 1 };

  it("only the executor and the docs-writer are pushing roles, and no plain-Bash review role is one", () => {
    expect([...PUSHING_ROLES].sort()).toEqual(["docs-writer", "executor"]);
    for (const role of REVIEW_ROLES) expect(PUSHING_ROLES.has(role), role).toBe(false);
  });

  for (const role of REVIEW_ROLES) {
    it(`a ${role} run that writes a file and commits it from the shell ends with no push: no push process, no new branch on the remote`, async () => {
      const dir = mkdtempSync(path.join(root, "pub-"));
      const remote = path.join(dir, "remote.git");
      sh("init", "--bare", "-b", "main", remote);
      const seed = path.join(dir, "seed");
      sh("init", "-b", "main", seed);
      writeFileSync(path.join(seed, "README.md"), "hello\n");
      sh("-C", seed, "add", "README.md");
      sh("-C", seed, "commit", "-m", "first");
      sh("-C", seed, "push", remote, "main");
      const calls: Array<readonly string[]> = [];
      const gitPath = createGitPath({
        capture: (command, args, env, timeoutMs) => (calls.push(args), runCapture(spawn, command, args, env, timeoutMs)),
        mirrorsRoot: path.join(dir, "cache", "mirrors"),
        stateDir: path.join(dir, "state"),
        remoteUrl: () => pathToFileURL(remote).href,
      });
      const job: GitJob = { repo: { id: randomUUID(), owner: "acme", name: "widgets", private: true }, continues: null, branch_prefix: "fx/", role };
      const work = path.join(dir, "work");
      mkdirSync(work, { mode: 0o700 });
      const { base } = await gitPath.prepare(job, lease, work);
      // What plain Bash lets a reviewer do: write a file, stage it and commit it.
      writeFileSync(path.join(work, "reviewer-note.txt"), "written from the shell\n");
      sh("-C", work, "add", "reviewer-note.txt");
      sh("-C", work, "commit", "-m", "reviewer change");
      const before = calls.length;
      expect(await gitPath.publish(job, lease, work, base)).toEqual({ pushed: false });
      expect(calls.length).toBe(before);
      expect(calls.some((args) => args.includes("push"))).toBe(false);
      expect(sh("-C", remote, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean)).toEqual(["refs/heads/main"]);
    });
  }
});
