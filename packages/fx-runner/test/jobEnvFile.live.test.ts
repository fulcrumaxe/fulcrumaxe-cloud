import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeArgv } from "../src/engines/claude/argv.js";
import { resolveClaudePath } from "../src/engines/claude/pin.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { JOB_ENV_FILE_NAME } from "../src/sandbox/jobEnvFile.js";
import { resolveSandboxTools, sandboxToolDirs } from "../src/sandbox/select.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * [live] D#6 C44-1 criterion 2: the installed agent CLI, in a real sandboxed job, with a start-up file that resets PATH.
 *
 * Opt-in, because it starts the real program and makes one short model turn on our own subscription:
 *
 *     FX_LIVE_CLI=1 pnpm exec vitest run test/jobEnvFile.live.test.ts      (FX_FORBID_MODEL_CALLS unset)
 *
 * Without `FX_LIVE_CLI=1` the test is skipped, and the reason is printed below, so a skip is never read as a pass.
 *
 * HOME is a throwaway directory made with mkdtemp; its `.profile` and `.bashrc` unset the NixOS marker, source `/etc/profile` when it exists
 * (otherwise set PATH=/usr/bin:/bin), which is the start-up pattern that drops the toolchain. It must not empty PATH: the CLI starts `bwrap` by name from the
 * login shell's own PATH before any env file can apply, so a rc that removed the system directories would stop every job, with or without this change. The real home is never written. The login
 * comes from `CLAUDE_CODE_OAUTH_TOKEN` when that is set; otherwise the one login file is copied (read only) from the real home into the throwaway one.
 *
 * What it proves, with the sandbox block built by the runner and the environment cleanEnv builds: the CLI reads `CLAUDE_ENV_FILE`, the sandbox lets the
 * shell read it, and the Bash tool's login shell sources it after its snapshot. The command is `command -v node && node --version && mktemp`;
 * the run must end without an error, print a node version, and print a path under the job's temp directory.
 */
const ON = process.env.FX_LIVE_CLI === "1" && process.env.FX_FORBID_MODEL_CALLS !== "1";
if (!ON) process.stdout.write("jobEnvFile.live: SKIPPED (set FX_LIVE_CLI=1 and unset FX_FORBID_MODEL_CALLS to run the installed CLI)\n");

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

describe.skipIf(!ON)("[live] the real agent CLI sources CLAUDE_ENV_FILE inside a real sandboxed job", () => {
  it("finds node, prints its version and a mktemp path under the job temp dir, although the start-up files reset PATH", { timeout: 240_000 }, async () => {
    const root = mkdtempSync(path.join(tmpRoot(), "fx-c441-live-"));
    dirs.push(root);
    const home = path.join(root, "home");
    mkdirSync(path.join(home, "default-bin"), { recursive: true });
    writeFileSync(path.join(home, ".bashrc"), ['unset __NIXOS_SET_ENVIRONMENT_DONE', 'if [ -r /etc/profile ]; then . /etc/profile; else PATH=/usr/bin:/bin; export PATH; fi', ""].join("\n"));
    writeFileSync(path.join(home, ".profile"), '. "$HOME/.bashrc"\n');
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined || process.env.CLAUDE_CODE_OAUTH_TOKEN === "") {
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
    let captured: { sandbox: Record<string, unknown>; jobEnv: Readonly<Record<string, string>> | undefined } | undefined;
    const host = createHostSandbox({
      credentials: { mode: "subscription" },
      envOptions,
      makeRuntime: (sandbox, _protected, jobEnv) => {
        captured = { sandbox, jobEnv };
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
      runId: "run", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir, capUsd: 0,
      networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }, envOptions), onEvent: () => undefined,
    }).launched;
    const tempDir = path.join(tempRoot, "live-1");
    expect(captured?.jobEnv?.CLAUDE_ENV_FILE).toBe(path.join(stateDir, "job-env", "live-1", JOB_ENV_FILE_NAME));

    // The real launch built the sandbox block and wrote the env file; the program is started the way the engine starts it, with plain `Bash`
    // allowed so the test command is not stopped by the role's prefix list (that is a separate change).
    const jobDir = path.join(root, "job-files");
    mkdirSync(jobDir, { recursive: true });
    const settingsPath = path.join(jobDir, "settings.json");
    const mcpPath = path.join(jobDir, "mcp.json");
    writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: "dontAsk", allow: ["Bash"] }, sandbox: captured!.sandbox }));
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    const env = cleanEnv({ mode: "subscription" }, { ...envOptions, jobEnv: captured!.jobEnv! });
    const argv = claudeArgv({ cliModel: "haiku", roleTools: ["Bash"], allowRules: ["Bash"], settingsPath, mcpPath });
    const prompt = "Use the Bash tool exactly once to run this command and nothing else: command -v node && node --version && mktemp\nThen reply with the command's output and stop.\n";
    const out = await run(binary, argv, env, workdir, prompt, 200_000);
    process.stdout.write(`jobEnvFile.live: exit ${String(out.code)}\n`);

    const records = out.stdout.split("\n").filter((line) => line.trim() !== "").map((line): Record<string, unknown> => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
    const result = records.find((record) => record.type === "result") as { is_error?: boolean; result?: string } | undefined;
    // Only the tool results' own content and error flag are judged; the CLI's metadata fields (a permission decision, say) are not output.
    const blocks = records
      .filter((record) => record.type === "user")
      .flatMap((record) => ((record.message as { content?: unknown } | undefined)?.content ?? []) as Array<{ type?: string; content?: unknown; is_error?: boolean }>)
      .filter((block) => block.type === "tool_result");
    const toolText = blocks.map((block) => (typeof block.content === "string" ? block.content : JSON.stringify(block.content))).join("\n");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.is_error !== true)).toBe(true);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    expect(result?.is_error).toBe(false);
    expect(toolText).not.toMatch(/command not found|permission denied/i);
    expect(toolText).toMatch(/v\d+\.\d+\.\d+/);
    // mktemp follows TMPDIR, which the env file set to the job temp dir
    expect(toolText).toContain(tempDir);
  });
});
