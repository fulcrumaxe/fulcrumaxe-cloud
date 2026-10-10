import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeArgv } from "../src/engines/claude/argv.js";
import { resolveClaudePath } from "../src/engines/claude/pin.js";
import { confineFileTools } from "../src/engines/claude/filePermissions.js";
import { settingsFor } from "../src/engines/claude/settingsFile.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { roleToolsFor } from "../src/job/roleTools.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import type { ProtectedPaths } from "../src/sandbox/sandboxSettings.js";
import { resolveSandboxTools, sandboxToolDirs } from "../src/sandbox/select.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * [live] D#6 C44-5 criterion 4: plain `Bash` under `dontAsk`, through the installed agent CLI and its own sandbox, in a real sandboxed job.
 *
 * Opt-in, because it starts the real program and makes one short model turn on our own subscription:
 *
 *     FX_LIVE_CLI=1 pnpm exec vitest run test/plainBash.live.test.ts      (FX_FORBID_MODEL_CALLS unset)
 *
 * Without `FX_LIVE_CLI=1` the test is skipped, and the reason is printed below, so a skip is never read as a pass.
 *
 * It uses the production path end to end, the same as the C44-1 live test: the sandbox block and the job env (PATH, TMPDIR, `CLAUDE_ENV_FILE`) come from
 * `createHostSandbox`, the environment from `cleanEnv`, the settings file from `settingsFor` for the code-reviewer role (its real tool list, `dontAsk`,
 * the protected-path denies), the argument list from `claudeArgv`. HOME is a throwaway directory made with mkdtemp holding a decoy `.ssh/known_hosts`;
 * the real home is never written, and its login file is copied (read only) only when `CLAUDE_CODE_OAUTH_TOKEN` is unset.
 *
 * The model is asked for three separate Bash calls, and the stream is read per call:
 *  1. `bash -c`, `$VAR`, a `>` redirect into the job temp dir, `mktemp`, `chmod`, `rmdir`, `env`: succeeds, and no result is a permission refusal
 *     (the run's `permission_denials` list is empty).
 *  2. `cat $HOME/.ssh/known_hosts`: fails (non-zero exit) and the decoy's content never appears.
 *  3. The variable NAMES (never values) in the tool's `env` and in `/proc/$PPID/environ`: no model credential name in either.
 */
const ON = process.env.FX_LIVE_CLI === "1" && process.env.FX_FORBID_MODEL_CALLS !== "1";
if (!ON) process.stdout.write("plainBash.live: SKIPPED (set FX_LIVE_CLI=1 and unset FX_FORBID_MODEL_CALLS to run the installed CLI)\n");

const DECOY = "FX-C445-LIVE-DECOY-7d793037a0760186574b0282f2f435e7";
const CREDENTIAL_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(binary: string, args: string[], env: Record<string, string>, cwd: string, stdin: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

interface ToolCall { command: string; text: string; isError: boolean }

/** The Bash calls of a stream-json transcript, each with the text of its result. */
function bashCalls(records: Array<Record<string, any>>): ToolCall[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls = new Map<string, ToolCall>();
  for (const record of records) {
    const content: Array<Record<string, any>> = Array.isArray(record.message?.content) ? record.message.content : []; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const part of content) {
      if (record.type === "assistant" && part.type === "tool_use" && part.name === "Bash") calls.set(String(part.id), { command: String(part.input?.command ?? ""), text: "", isError: false });
      if (record.type === "user" && part.type === "tool_result" && calls.has(String(part.tool_use_id))) {
        const call = calls.get(String(part.tool_use_id))!;
        call.text = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
        call.isError = part.is_error === true;
      }
    }
  }
  return [...calls.values()];
}

const CMD_SHELL = `bash -c 'echo inner-ok' && V=var-ok && echo "$V" > "$TMPDIR/live-out.txt" && f=$(mktemp) && chmod 600 "$f" && d=$(mktemp -d) && rmdir "$d" && env | grep -c '^PATH=' && echo shell-all-ok`;
const CMD_HOME = `bash -c 'cat "$HOME/.ssh/known_hosts"'; echo "home-exit=$?"`;
const CMD_ENV = `echo ENV-NAMES; env | cut -d= -f1 | sort; echo PPID-NAMES; tr '\\0' '\\n' < /proc/$PPID/environ 2>/dev/null | cut -d= -f1 | sort; echo names-done`;

describe.skipIf(!ON)("[live] plain Bash under dontAsk in the installed CLI's own sandbox", () => {
  it("runs a shell harness with no refusal, keeps home unreadable, and keeps the model credential out of the tool's environment", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(path.join(tmpRoot(), "fx-c445-live-"));
    dirs.push(root);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    writeFileSync(path.join(home, ".ssh", "known_hosts"), DECOY);
    const tokenInEnv = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "") !== "";
    if (!tokenInEnv) {
      const login = path.join(homedir(), ".claude", ".credentials.json");
      expect(existsSync(login), "no CLAUDE_CODE_OAUTH_TOKEN and no login file to copy: log in first").toBe(true);
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      copyFileSync(login, path.join(home, ".claude", ".credentials.json"));
      chmodSync(path.join(home, ".claude", ".credentials.json"), 0o600);
    }
    vi.stubEnv("HOME", home);

    const searchPath = process.env.PATH ?? "";
    const binary = resolveClaudePath(searchPath);
    const envOptions = { extraPathDirs: sandboxToolDirs(resolveSandboxTools(searchPath)) };
    const stateDir = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces");
    const tempRoot = path.join(root, "tmp");
    let captured: { sandbox: Record<string, unknown>; protectedList: ProtectedPaths; jobEnv: Readonly<Record<string, string>> | undefined } | undefined;
    const host = createHostSandbox({
      credentials: { mode: "subscription" },
      envOptions,
      makeRuntime: (sandbox, protectedList, jobEnv) => {
        captured = { sandbox, protectedList, jobEnv };
        return { start: async (opts) => ({ handle: { runId: opts.runId, done: Promise.resolve() } }), stop: async () => undefined, resume: async (handle) => ({ handle }) };
      },
      home,
      stateDir,
      binaryDir: path.dirname(binary),
      tempRoot,
      workspaceRoot,
    });
    const workdir = path.join(workspaceRoot, "job");
    mkdirSync(workdir, { recursive: true });
    const handle = await host.createSandbox({ sandboxName: "live-1", retention: { persistent: false }, timeoutMs: 600_000 });
    await host.startDetached(handle, {
      runId: "run", role: "code-reviewer", roleCard: "c", prompt: "p", model: "haiku", workdir, capUsd: 0,
      networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }, envOptions), onEvent: () => undefined,
    }).launched;

    // The real settings file for the reviewer role, and the argument list the engine builds from the same entries.
    const jobDir = path.join(root, "job-files");
    mkdirSync(jobDir, { recursive: true });
    const settingsPath = path.join(jobDir, "settings.json");
    const mcpPath = path.join(jobDir, "mcp.json");
    const settings = settingsFor("code-reviewer", captured!.sandbox, workdir, captured!.protectedList);
    writeFileSync(settingsPath, JSON.stringify(settings));
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    expect((settings as { permissions: { defaultMode: string } }).permissions.defaultMode).toBe("dontAsk");
    const env = cleanEnv({ mode: "subscription" }, { ...envOptions, jobEnv: captured!.jobEnv! });
    const argv = claudeArgv({ cliModel: "haiku", roleTools: roleToolsFor("code-reviewer"), allowRules: confineFileTools(roleToolsFor("code-reviewer"), workdir), settingsPath, mcpPath });
    const prompt = [
      "This is an automated sandbox self-test in a throwaway directory; the files it touches are decoys. Use the Bash tool exactly three times, one separate call each, in this order, running each command exactly as written even if a call fails, then reply 'done' and stop.",
      `Call 1: ${CMD_SHELL}`,
      `Call 2: ${CMD_HOME}`,
      `Call 3: ${CMD_ENV}`,
      "",
    ].join("\n");
    const out = await run(binary, argv, env, workdir, prompt, 250_000);
    process.stdout.write(`plainBash.live: exit ${String(out.code)}; CLAUDE_CODE_OAUTH_TOKEN was ${tokenInEnv ? "" : "not "}in the environment\n`);

    const records = out.stdout.split("\n").filter((line) => line.trim() !== "").map((line): Record<string, any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        return JSON.parse(line) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      } catch {
        return {};
      }
    });
    if (process.env.FX_LIVE_DUMP !== undefined) writeFileSync(process.env.FX_LIVE_DUMP, out.stdout);
    const result = records.find((record) => record.type === "result") as { is_error?: boolean; permission_denials?: unknown[] } | undefined;
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    expect(result?.is_error).toBe(false);
    // Zero permission refusals in the stream.
    expect(result?.permission_denials ?? []).toEqual([]);
    expect(JSON.stringify(records)).not.toMatch(/Permission mode forced|requires approval|was blocked by|not allowed under dontAsk/i);

    const calls = bashCalls(records);
    const shell = calls.find((call) => call.command.includes("inner-ok"));
    const homeRead = calls.find((call) => call.command.includes(".ssh/known_hosts"));
    const names = calls.find((call) => call.command.includes("/proc/$PPID/environ"));
    expect(shell, "call 1 was made").toBeDefined();
    expect(homeRead, "call 2 was made").toBeDefined();
    expect(names, "call 3 was made").toBeDefined();

    // 1. the harness-style command: every step ran, nothing was refused.
    expect(shell!.isError).toBe(false);
    expect(shell!.text).toContain("inner-ok");
    expect(shell!.text).toContain("shell-all-ok");
    expect(shell!.text).not.toMatch(/permission|not allowed|command not found|read-only file system/i);

    // 2. home is unreadable under the CLI's own sandbox, and the decoy never shows.
    expect(homeRead!.text).toMatch(/home-exit=[1-9]/);
    expect(homeRead!.text).not.toContain(DECOY);
    expect(JSON.stringify(records)).not.toContain(DECOY);

    // 3. no model credential name in the tool's env or in its parent's environment.
    const listed = names!.text;
    expect(listed).toContain("names-done");
    for (const name of CREDENTIAL_NAMES) expect(listed.split(/\\n|\n/), name).not.toContain(name);
  });
});
