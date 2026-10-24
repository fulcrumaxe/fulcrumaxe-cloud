import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROPOSAL_VERIFIER_RUNNER_TOOLS, VERIFIER_READ_GUARD_SCRIPT } from "@fulcrumaxe/runner-protocol";
import { roleToolsDigest as cloudDigest } from "@fx/runner";
import { describe, expect, it } from "vitest";
import { claudeArgv } from "../src/engines/claude/argv.js";
import { EngineRefusal } from "../src/engines/claude/refusal.js";
import { settingsFor, writeJobFiles } from "../src/engines/claude/settingsFile.js";
import { verifyJob } from "../src/daemon/verifyJob.js";
import { ROLE_TOOLS, roleToolsDigest, roleToolsFor } from "../src/job/roleTools.js";
import { protectedPaths } from "../src/sandbox/sandboxSettings.js";
import { RUNNER_BUILD_CAPABILITIES } from "../src/version.js";
import { KEYRING, NOW, jobFor, signRaw } from "./helpers/signedJob.js";

const ROLE = "proposal-verifier";
const SANDBOX = { enabled: true, filesystem: { denyRead: ["~"] } };
const PROTECTED = protectedPaths({ home: "/home/jane", stateDir: "/home/jane/.fx-runner", binaryDir: "/home/jane/.local/bin" });
const SHA = "c".repeat(40);

type Hook = { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> };
type Settings = { disableAllHooks: boolean; hooks?: { PreToolUse?: Hook[] } & Record<string, unknown>; permissions: { allow: string[]; deny: string[]; defaultMode: string; blockReadsOutsideWorkingDirectories: boolean } };

/** D#483 S4-b2c: the claim verifier on a local runner. */
describe("the claim verifier's tools on a runner", () => {
  it("are Read, Glob and Grep only, and hash to the digest the cloud signs for a verifier job", () => {
    expect([...roleToolsFor(ROLE)]).toEqual(["Read", "Glob", "Grep"]);
    expect(roleToolsFor(ROLE)).toEqual(PROPOSAL_VERIFIER_RUNNER_TOOLS);
    expect(Object.isFrozen(ROLE_TOOLS[ROLE])).toBe(true);
    expect(roleToolsDigest(ROLE)).toBe(cloudDigest(ROLE));
    // A different list (the sandbox's checkout-path entry, or one more tool) is a different digest, so a mismatched runner refuses the job.
    expect(roleToolsDigest(ROLE)).not.toBe(roleToolsDigest("code-reviewer"));
  });

  it("the CLI is started with exactly those three tools", () => {
    const argv = claudeArgv({ cliModel: "claude-sonnet-4-5", roleTools: roleToolsFor(ROLE), allowRules: [], settingsPath: "/s", mcpPath: "/m" });
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
  });

  it("this build advertises the capability on hello", () => {
    expect(RUNNER_BUILD_CAPABILITIES).toContain("proposal_verifier");
  });
});

describe("the claim verifier's settings file", () => {
  const WS = "/home/jane/.local/state/fx-runner/workspaces/run-1";

  it("has exactly one hook, the shared read guard on Read, Glob and Grep, given this checkout", () => {
    const file = settingsFor(ROLE, SANDBOX, WS, PROTECTED) as Settings;
    expect(file.disableAllHooks).toBe(false);
    expect(Object.keys(file.hooks ?? {})).toEqual(["PreToolUse"]);
    expect(file.hooks?.PreToolUse).toHaveLength(1);
    const hook = file.hooks!.PreToolUse![0]!;
    expect(hook.matcher).toBe("Read|Glob|Grep");
    expect(hook.hooks).toEqual([{ type: "command", command: `/bin/sh -c '${VERIFIER_READ_GUARD_SCRIPT}' fx-read-guard ${WS}`, timeout: 5 }]);
  });

  it("confines reads to the checkout, denies its .git and .env files and the protected paths, and allows nothing else", () => {
    const { permissions } = settingsFor(ROLE, SANDBOX, WS, PROTECTED) as Settings;
    expect(permissions.defaultMode).toBe("dontAsk");
    expect(permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(permissions.allow).toEqual([`Read(/${WS})`, `Read(/${WS}/**)`]);
    for (const p of [".git", ".git/**", "**/.git", "**/.git/**", ".env*", "**/.env*"]) expect(permissions.deny).toContain(`Read(/${WS}/${p})`);
    expect(permissions.deny).toContain("Read(//home/jane/.fx-runner)");
    // The deny floor holds Edit rules for the protected paths; the allow list holds nothing but the two Read rules.
    expect(JSON.stringify(permissions.allow)).not.toMatch(/Bash|Edit|Write|WebFetch|mcp__/);
  });

  it("every other role still runs with all hooks off (the verifier is the only exception)", () => {
    for (const role of Object.keys(ROLE_TOOLS).filter((r) => r !== ROLE)) {
      const file = settingsFor(role, SANDBOX, WS, PROTECTED) as Settings;
      expect(file.disableAllHooks, role).toBe(true);
      expect(file, role).not.toHaveProperty("hooks");
    }
  });

  it("refuses to start in a checkout the hook command could not carry unquoted", () => {
    for (const ws of ["/home/jane/a b", "/home/jane/a'b", "/home/jane/$(id)", "/home/jane/a;b"]) {
      expect(() => settingsFor(ROLE, SANDBOX, ws, PROTECTED), ws).toThrow(EngineRefusal);
    }
  });

  it("refuses a checkout that is not its own real path (a link on the way to it)", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "s4b2c2_ws-")));
    const real = path.join(root, "real");
    mkdirSync(real);
    symlinkSync(real, path.join(root, "link"));
    expect(() => writeJobFiles(path.join(root, "job-a"), path.join(root, "link"), ROLE, SANDBOX, PROTECTED)).toThrow(EngineRefusal);
    const files = writeJobFiles(path.join(root, "job-b"), real, ROLE, SANDBOX, PROTECTED);
    expect((JSON.parse(readFileSync(files.settingsPath, "utf8")) as Settings).hooks?.PreToolUse).toHaveLength(1);
  });
});

describe("the read guard, run the way the CLI runs a command hook (sh -c <command>)", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "s4b2c2_guard-")));
  const ws = path.join(root, "checkout");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(path.join(root, "outside"));
  writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "outside", "secret"), "s\n");
  // A committed link that names a place outside the tree by an in-tree name.
  symlinkSync(path.join(root, "outside"), path.join(ws, "escape"));
  const command = ((settingsFor(ROLE, SANDBOX, ws, PROTECTED) as Settings).hooks!.PreToolUse![0]!.hooks[0]!).command;
  const run = (tool: string, input: Record<string, unknown>): number | null =>
    spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ session_id: "s", tool_name: tool, tool_input: input, tool_use_id: "t" }), cwd: ws, timeout: 10_000 }).status;

  it("lets a read inside the checkout through", () => {
    expect(run("Read", { file_path: path.join(ws, "src", "a.ts") })).toBe(0);
    expect(run("Grep", { pattern: "a", path: "src" })).toBe(0);
    expect(run("Glob", { pattern: "src/**/*.ts" })).toBe(0);
  });

  it("refuses an absolute path outside, a climb, a link out of the tree, .git, .env, brace alternation and another tool (fail closed)", () => {
    expect(run("Read", { file_path: path.join(root, "outside", "secret") })).toBe(2);
    expect(run("Read", { file_path: "../outside/secret" })).toBe(2);
    expect(run("Read", { file_path: path.join(ws, "escape", "secret") })).toBe(2);
    expect(run("Grep", { pattern: "s", path: "escape" })).toBe(2);
    expect(run("Read", { file_path: path.join(ws, ".git", "config") })).toBe(2);
    expect(run("Read", { file_path: path.join(ws, ".env") })).toBe(2);
    expect(run("Glob", { pattern: "{/etc,src}/*" })).toBe(2);
    expect(run("Bash", { command: "cat /etc/passwd" })).toBe(2);
    expect(run("Read", { file_path: "~/.ssh/id_ed25519" })).toBe(2);
  });
});

describe("a verifier job names its pinned commit", () => {
  const check = (signed: unknown) => verifyJob(signed, KEYRING, NOW);
  const base = { role: ROLE, task: jobFor().task, role_tools_sha256: roleToolsDigest(ROLE) } as const;

  it("without review.head_sha it is refused (review_sha_missing); with it, it is accepted", () => {
    expect(check(signRaw(jobFor(base)))).toEqual({ ok: false, reason: "review_sha_missing" });
    expect(check(signRaw(jobFor({ ...base, review: { head_sha: SHA } }))).ok).toBe(true);
  });

  it("a job signed with another tool list (the sandbox's) is refused before anything runs", () => {
    const signed = signRaw(jobFor({ ...base, review: { head_sha: SHA }, role_tools_sha256: cloudDigest("code-reviewer") }));
    expect(check(signed).ok).toBe(false);
  });
});
