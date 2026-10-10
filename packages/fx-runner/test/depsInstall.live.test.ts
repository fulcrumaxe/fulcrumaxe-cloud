import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeArgv } from "../src/engines/claude/argv.js";
import { resolveClaudePath } from "../src/engines/claude/pin.js";
import { createDepsInstaller } from "../src/daemon/depsInstall.js";
import { runInstall } from "../src/engines/claude/capture.js";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { resolveSandboxTools, sandboxToolDirs } from "../src/sandbox/select.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * [live] D#6 C44-4 / G-C44-7: the runner installs the workspace's dependencies on the host (no repo code), then the installed agent CLI, in a real sandboxed REVIEW job, runs one small package's tests.
 *
 * Opt-in, because it starts the real program, reaches the real npm registry and makes one model turn on our own subscription:
 *
 *     FX_LIVE_CLI=1 pnpm exec vitest run test/depsInstall.live.test.ts      (FX_FORBID_MODEL_CALLS unset)
 *
 * Without `FX_LIVE_CLI=1` the test is skipped, and the reason is printed below, so a skip is never read as a pass.
 *
 * The workspace is this repository at HEAD (`git archive`), so its own lockfile is the one installed from. The job's sandbox is built by the runner
 * (registry.npmjs.org allowed, a per-repo package store, the job's own temp directory) and started the way the engine starts it, with plain `Bash`.
 * The runner's own install (`createDepsInstaller`, the real process-group capture, the real pnpm and the real registry) runs first and must report `installed`;
 * the agent then runs only `pnpm exec vitest run` in `packages/net-guard`. It passes only when:
 *  - the run ends without an error and every tool result is a success (zero refusals);
 *  - no tool output holds a read-only or permission refusal (this is the `node_modules/.bin` refusal seen in the #595 fix round);
 *  - the vitest summary reports passed tests and no failed ones;
 *  - `pnpm-lock.yaml` is byte-identical to the one that went in.
 * The CLI's own login is used the way `jobEnvFile.live.test.ts` does (`CLAUDE_CODE_OAUTH_TOKEN`, or the one login file copied into a throwaway HOME).
 */
const ON = process.env.FX_LIVE_CLI === "1" && process.env.FX_FORBID_MODEL_CALLS !== "1";
if (!ON) process.stdout.write("depsInstall.live: SKIPPED (set FX_LIVE_CLI=1 and unset FX_FORBID_MODEL_CALLS to run the installed CLI)\n");

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

describe.skipIf(!ON)("[live] a review job installs from the frozen lockfile and runs one package's tests in the real sandbox", () => {
  it("the runner installs, then vitest runs in packages/net-guard in the sandbox, with zero refusals and the lockfile untouched", { timeout: 1_500_000 }, async () => {
    const root = mkdtempSync(path.join(tmpRoot(), "fxc444-live-"));
    dirs.push(root);
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
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
    const storeRoot = path.join(root, "pnpm-store");
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
      packageStoreRoot: storeRoot,
    });

    // The repository at HEAD, from the object database (no working-tree state, no node_modules), is the job's workspace.
    const workdir = path.join(workspaceRoot, "job");
    mkdirSync(workdir, { recursive: true });
    const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
    const archive = spawnSync("git", ["archive", "HEAD"], { cwd: repoRoot, maxBuffer: 512 * 1024 * 1024 });
    expect(archive.status).toBe(0);
    expect(spawnSync("tar", ["-x", "-C", workdir], { input: archive.stdout }).status).toBe(0);
    const lockBefore = readFileSync(path.join(workdir, "pnpm-lock.yaml"));

    // The runner's install, before the agent's sandbox exists. The agent's own sandbox cannot do this (scrub mode protects node_modules/.bin).
    const said: string[] = [];
    const outcome = await createDepsInstaller({ capture: (command, args, env, cwd, timeoutMs, tail, signal) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal), envOptions, say: (line) => said.push(line) }).run({ workspace: workdir, registryHost: "registry.npmjs.org", storeDir: path.join(storeRoot, "fxc444-live") });
    process.stdout.write(`depsInstall.live: runner install ${JSON.stringify(outcome)} ${said.join(" | ")}\n`);
    expect(outcome, said.join(" | ")).toEqual({ kind: "installed" });

    const handle = await host.createSandbox({ sandboxName: "live-1", retention: { persistent: false }, timeoutMs: 1_500_000 });
    await host.startDetached(handle, {
      runId: "run", role: "code-reviewer", roleCard: "c", prompt: "p", model: "sonnet", workdir, capUsd: 0,
      networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }],
      allowances: { entries: [{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install" }], commandTimeoutS: 1200, storeKey: "fxc444-live" },
      env: cleanEnv({ mode: "subscription" }, envOptions), onEvent: () => undefined,
    }).launched;

    const jobDir = path.join(root, "job-files");
    mkdirSync(jobDir, { recursive: true });
    const settingsPath = path.join(jobDir, "settings.json");
    const mcpPath = path.join(jobDir, "mcp.json");
    writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: "dontAsk", allow: ["Bash"] }, sandbox: captured!.sandbox }));
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    const env = cleanEnv({ mode: "subscription" }, { ...envOptions, jobEnv: captured!.jobEnv! });
    const argv = claudeArgv({ cliModel: "haiku", roleTools: ["Bash"], allowRules: ["Bash"], settingsPath, mcpPath });
    const prompt = [
      "Dependencies are already installed; do not install anything. Use the Bash tool to run this one command, and nothing else.",
      "cd packages/net-guard && pnpm exec vitest run",
      "If it fails, do not work around it: reply with the command and its exact error, and stop.",
      "When it has run, reply with the last lines of the vitest output and stop.",
      "",
    ].join("\n");
    const out = await run(binary, argv, env, workdir, prompt, 1_400_000);
    process.stdout.write(`depsInstall.live: exit ${String(out.code)}\n`);

    const records = out.stdout.split("\n").filter((line) => line.trim() !== "").map((line): Record<string, unknown> => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
    const result = records.find((record) => record.type === "result") as { is_error?: boolean } | undefined;
    const blocks = records
      .filter((record) => record.type === "user")
      .flatMap((record) => ((record.message as { content?: unknown } | undefined)?.content ?? []) as Array<{ type?: string; content?: unknown; is_error?: boolean }>)
      .filter((block) => block.type === "tool_result");
    const toolText = blocks.map((block) => (typeof block.content === "string" ? block.content : JSON.stringify(block.content))).join("\n");
    process.stdout.write(`depsInstall.live: ${String(blocks.length)} tool results, ${String(blocks.filter((block) => block.is_error === true).length)} errors\n${toolText.slice(-1500)}\n`);

    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.every((block) => block.is_error !== true), "a tool call was refused or failed").toBe(true);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    expect(result?.is_error).toBe(false);
    expect(toolText).not.toMatch(/read-only file system|EROFS|EACCES|EPERM|permission denied|operation not permitted|blocked by sandbox|ENOTFOUND|EAI_AGAIN/i);
    expect(toolText).toMatch(/Tests\s+\d+ passed/);
    expect(toolText).not.toMatch(/Tests\s+.*\d+ failed/);
    expect(readFileSync(path.join(workdir, "pnpm-lock.yaml")).equals(lockBefore), "pnpm-lock.yaml changed").toBe(true);
  });
});
