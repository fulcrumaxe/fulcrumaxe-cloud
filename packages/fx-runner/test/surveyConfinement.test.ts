import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFINED_READ_ROLES, SURVEY_ROLE, VERIFIER_READ_GUARD_SCRIPT, structuredSchemaFor } from "@fulcrumaxe/runner-protocol";
import { roleToolsDigest as cloudDigest, toolsForRole as cloudToolsForRole } from "@fx/runner";
import { describe, expect, it } from "vitest";
import { claudeArgv } from "../src/engines/claude/argv.js";
import { EngineRefusal } from "../src/engines/claude/refusal.js";
import { settingsFor, writeJobFiles } from "../src/engines/claude/settingsFile.js";
import { verifyJob } from "../src/daemon/verifyJob.js";
import { roleToolsDigest, roleToolsFor } from "../src/job/roleTools.js";
import { protectedPaths, sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { RUNNER_BUILD_CAPABILITIES } from "../src/version.js";
import { KEYRING, NOW, jobFor, signRaw } from "./helpers/signedJob.js";
import { tempDir } from "./helpers/tempTree.js";

/**
 * D#845 ON-10c: the project surveyor is a confined read-only role on a local runner. It reads the checkout behind the shared read guard, holds the four read tools its job is signed with (the cloud's own list, which
 * `toolsForRole` keeps for it), and has no tool that writes or reaches. Its working copy is read-only to a shell too (the sandbox block), and its answer is asked for in the survey's schema.
 */
const SANDBOX = { enabled: true, filesystem: { denyRead: ["~"] } };
const PROTECTED = protectedPaths({ home: "/home/jane", stateDir: "/home/jane/.fx-runner", binaryDir: "/home/jane/.local/bin" });
const WS = "/home/jane/.local/state/fx-runner/workspaces/run-1";
const SHA = "c".repeat(40);

type Hook = { matcher: string; hooks: Array<{ type: string; command: string; timeout: number; onFailure?: string }> };
type Settings = { disableAllHooks: boolean; hooks?: { PreToolUse?: Hook[] } & Record<string, unknown>; permissions: { allow: string[]; deny: string[]; defaultMode: string; blockReadsOutsideWorkingDirectories: boolean }; sandbox: Record<string, unknown> };

describe("the survey role's tools on a runner", () => {
  it("are the four read tools, the cloud's own list for the role, hashing to the digest the cloud signs", () => {
    expect([...roleToolsFor(SURVEY_ROLE)]).toEqual(["Read", "Glob", "Grep", "LS"]);
    expect([...cloudToolsForRole(SURVEY_ROLE)]).toEqual(["Read", "Glob", "Grep", "LS"]);
    expect(roleToolsDigest(SURVEY_ROLE)).toBe(cloudDigest(SURVEY_ROLE));
    expect(roleToolsDigest(SURVEY_ROLE)).not.toBe(roleToolsDigest("proposal-verifier"));
    expect(CONFINED_READ_ROLES.has(SURVEY_ROLE)).toBe(true);
  });

  it("the CLI is started with exactly those tools and the survey's schema", () => {
    const argv = claudeArgv({ cliModel: "claude-sonnet-4-5", roleTools: roleToolsFor(SURVEY_ROLE), allowRules: [], settingsPath: "/s", mcpPath: "/m", jsonSchema: structuredSchemaFor(SURVEY_ROLE)! });
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,LS");
    expect(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!)).toEqual(structuredSchemaFor(SURVEY_ROLE));
    expect(argv.some((part) => /^(Bash|Edit|Write|MultiEdit|NotebookEdit)/.test(part))).toBe(false);
    // the two web tools are named only to be refused
    expect(argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--disallowedTools") + 3)).toEqual(["WebFetch", "WebSearch"]);
  });

  it("a build that advertises survey_v1 is this one: the capability is on the build list", () => {
    expect(RUNNER_BUILD_CAPABILITIES).toContain("survey_v1");
  });
});

describe("the survey role's settings file", () => {
  it("has exactly one hook, the shared read guard on Read, Glob and Grep, given this checkout, failing closed", () => {
    const file = settingsFor(SURVEY_ROLE, SANDBOX, WS, PROTECTED) as Settings;
    expect(file.disableAllHooks).toBe(false);
    expect(file.hooks?.PreToolUse).toHaveLength(1);
    const hook = file.hooks!.PreToolUse![0]!;
    expect(hook.matcher).toBe("Read|Glob|Grep");
    expect(hook.hooks).toEqual([{ type: "command", command: `/bin/sh -c '${VERIFIER_READ_GUARD_SCRIPT}' fx-read-guard ${WS}`, timeout: 5, onFailure: "block" }]);
  });

  it("confines reads to the checkout, denies .git, .env, the protected paths and LS (which the guard's script does not read), and allows nothing that writes", () => {
    const { permissions } = settingsFor(SURVEY_ROLE, SANDBOX, WS, PROTECTED) as Settings;
    expect(permissions.defaultMode).toBe("dontAsk");
    expect(permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(permissions.allow).toEqual([`Read(/${WS})`, `Read(/${WS}/**)`]);
    for (const p of [".git", ".git/**", "**/.git", "**/.git/**", ".env*", "**/.env*"]) expect(permissions.deny).toContain(`Read(/${WS}/${p})`);
    expect(permissions.deny).toContain("Read(//home/jane/.fx-runner)");
    expect(permissions.deny).toContain("LS");
    expect(JSON.stringify(permissions.allow)).not.toMatch(/Bash|Edit|Write|WebFetch|mcp__/);
  });

  it("no other confined role denies LS (it is the survey's own tool list that names it)", () => {
    for (const role of ["proposal-verifier", "discovery-analyst"]) expect((settingsFor(role, SANDBOX, WS, PROTECTED) as Settings).permissions.deny).not.toContain("LS");
  });

  it("refuses to start in a checkout the hook command could not carry unquoted, and in one that is not its own real path", () => {
    for (const ws of ["/home/jane/a b", "/home/jane/a'b", "/home/jane/$(id)", "/home/jane/a;b"]) expect(() => settingsFor(SURVEY_ROLE, SANDBOX, ws, PROTECTED), ws).toThrow(EngineRefusal);
    const root = realpathSync(tempDir("on10c_ws-"));
    const real = path.join(root, "real");
    mkdirSync(real);
    symlinkSync(real, path.join(root, "link"));
    expect(() => writeJobFiles(path.join(root, "job-a"), path.join(root, "link"), SURVEY_ROLE, SANDBOX, PROTECTED)).toThrow(EngineRefusal);
    const files = writeJobFiles(path.join(root, "job-b"), real, SURVEY_ROLE, SANDBOX, PROTECTED);
    expect((JSON.parse(readFileSync(files.settingsPath, "utf8")) as Settings).hooks?.PreToolUse).toHaveLength(1);
  });
});

describe("the read guard for the survey role, run the way the CLI runs a command hook (sh -c <command>)", () => {
  const root = realpathSync(tempDir("on10c_guard-"));
  const ws = path.join(root, "checkout");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  mkdirSync(path.join(root, "outside"));
  writeFileSync(path.join(ws, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "outside", "secret"), "s\n");
  symlinkSync(path.join(root, "outside"), path.join(ws, "escape"));
  const command = ((settingsFor(SURVEY_ROLE, SANDBOX, ws, PROTECTED) as Settings).hooks!.PreToolUse![0]!.hooks[0]!).command;
  const run = (tool: string, input: Record<string, unknown>): number | null =>
    spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({ session_id: "s", tool_name: tool, tool_input: input, tool_use_id: "t" }), cwd: ws, timeout: 10_000 }).status;

  it("lets a read inside the checkout through", () => {
    expect(run("Read", { file_path: path.join(ws, "src", "a.ts") })).toBe(0);
    expect(run("Grep", { pattern: "a", path: "src" })).toBe(0);
    expect(run("Glob", { pattern: "src/**/*.ts" })).toBe(0);
  });

  it("refuses an absolute path outside, a climb, a link out of the tree, .git, .env, brace alternation, a tool the guard does not read (LS, Write, Bash) and a home path", () => {
    expect(run("Read", { file_path: path.join(root, "outside", "secret") })).toBe(2);
    expect(run("Read", { file_path: "../outside/secret" })).toBe(2);
    expect(run("Read", { file_path: path.join(ws, "escape", "secret") })).toBe(2);
    expect(run("Grep", { pattern: "s", path: "escape" })).toBe(2);
    expect(run("Read", { file_path: path.join(ws, ".git", "config") })).toBe(2);
    expect(run("Read", { file_path: path.join(ws, ".env") })).toBe(2);
    expect(run("Glob", { pattern: "{/etc,src}/*" })).toBe(2);
    expect(run("LS", { path: "/" })).toBe(2);
    expect(run("Write", { file_path: path.join(ws, "x"), content: "x" })).toBe(2);
    expect(run("Bash", { command: "cat /etc/passwd" })).toBe(2);
    expect(run("Read", { file_path: "~/.ssh/id_ed25519" })).toBe(2);
  });
});

describe("a survey job names its pinned commit", () => {
  const check = (signed: unknown) => verifyJob(signed, KEYRING, NOW);
  const base = { role: SURVEY_ROLE, task: { ...jobFor().task, kind: "survey" as const }, role_tools_sha256: roleToolsDigest(SURVEY_ROLE) } as const;

  it("without review.head_sha it is refused (review_sha_missing); with it, it is accepted", () => {
    expect(check(signRaw(jobFor(base)))).toEqual({ ok: false, reason: "review_sha_missing" });
    expect(check(signRaw(jobFor({ ...base, review: { head_sha: SHA } }))).ok).toBe(true);
  });

  it("a job signed with another tool list (the verifier's three) is refused before anything runs", () => {
    expect(check(signRaw(jobFor({ ...base, role_tools_sha256: roleToolsDigest("proposal-verifier"), review: { head_sha: SHA } }))).ok).toBe(false);
  });
});

describe("the OS-sandbox block for a read-only workspace", () => {
  const root = realpathSync(tempDir("on10c_block-"));
  const input = { workspace: path.join(root, "work", "w1"), tempDir: path.join(root, "tmp", "t1"), home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin"), workspaceRoot: path.join(root, "work"), tempRoot: path.join(root, "tmp") };

  it("a read-only workspace is denied for writes and is not a write grant; the temp directory is the only one", () => {
    const block = sandboxSettings({ ...input, readOnlyWorkspace: true }) as { filesystem: { allowWrite: string[]; denyWrite: string[]; allowRead: string[] } };
    expect(block.filesystem.allowWrite).toEqual([input.tempDir]);
    expect(block.filesystem.denyWrite).toContain(input.workspace);
    expect(block.filesystem.allowRead).toContain(input.workspace);
  });

  it("without the flag nothing changes: the workspace is the first write grant", () => {
    const block = sandboxSettings(input) as { filesystem: { allowWrite: string[]; denyWrite: string[] } };
    expect(block.filesystem.allowWrite).toEqual([input.workspace, input.tempDir]);
    expect(block.filesystem.denyWrite).not.toContain(input.workspace);
  });
});
