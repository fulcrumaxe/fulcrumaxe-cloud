import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCredentialMatches, isInitLine } from "../src/engines/claude/credentialCheck.js";
import { createClaudeEngine } from "../src/engines/claude/engine.js";
import { resolveClaudePath, storedBinarySource } from "../src/engines/claude/pin.js";
import { createMemoryLedger, runJob } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { resolveSandboxTools, sandboxToolDirs } from "../src/sandbox/select.js";
import { sampleJob } from "./helpers/sampleJob.js";

/**
 * D#6 R5b-3 real contract, at $0: the installed agent CLI is started through the runner's own path (`runJob`, the host sandbox, the engine) in
 * `api_key` mode with a key that is well-formed and INVALID. Opt-in, because it starts the real program: it is skipped unless
 * `FX_API_KEY_REAL_CLI=1`, and always skipped under `FX_FORBID_MODEL_CALLS=1` (the repo's model-call guard blocks the start anyway).
 *
 *     FX_API_KEY_REAL_CLI=1 pnpm exec vitest run test/apiKeyRealCli.test.ts      (with FX_FORBID_MODEL_CALLS unset)
 *
 * Nothing can be spent: the only credential the program can find is the invalid key (HOME is an empty directory, so no login is there; the
 * runner's clean environment carries no token), so the provider answers with an authentication failure. What it proves:
 *  - the first line the program prints is the init line, and it names the environment key as the credential source (`ANTHROPIC_API_KEY`), which is
 *    what `initCredentialMatches("api_key", ...)` requires;
 *  - the authentication failure surfaces as a closed reason of the runner (never a success, never free text), and the key is in no log line.
 */
const ON = process.env.FX_API_KEY_REAL_CLI === "1" && process.env.FX_FORBID_MODEL_CALLS !== "1";
// Assembled from fragments so no token-shaped literal sits in the source. Well-formed, and not any account's key.
const INVALID = ["sk-ant-", "api03-", "THISKEYISINVALID0123456789abcdefghijklmnopqrstuvwxyz0123456789"].join("");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "fxr-realkey-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!ON)("the real agent CLI with an invalid API key", () => {
  it("prints the init line naming ANTHROPIC_API_KEY, then fails to authenticate as a closed reason, with the key in no log line", { timeout: 120_000 }, async () => {
    const home = path.join(scratch, "home");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) vi.stubEnv(name, "");
    const searchPath = process.env.PATH ?? "";
    const binary = resolveClaudePath(searchPath);
    const envOptions = { extraPathDirs: sandboxToolDirs(resolveSandboxTools(searchPath)) };
    const credentials = { mode: "api_key", apiKey: INVALID } as const;
    const stateDir = path.join(scratch, "state");
    const logDir = path.join(stateDir, "logs");
    const workspaceRoot = path.join(scratch, "workspaces");
    const host = createHostSandbox({
      credentials,
      envOptions,
      makeRuntime: (sandbox, protectedList) =>
        createClaudeEngine({
          binary: storedBinarySource({ storedPath: binary, cacheDir: path.join(scratch, "cache"), spawn }),
          credentials,
          envOptions,
          sandboxSettings: sandbox,
          protectedPaths: protectedList,
          jobsDir: path.join(stateDir, "jobs"),
          logDir,
          sessionsFile: path.join(stateDir, "sessions.json"),
        }),
      home,
      stateDir,
      binaryDir: path.dirname(binary),
      tempRoot: path.join(scratch, "tmp"),
      workspaceRoot,
    });
    const runId = "c0ffee00-0000-4000-8000-5b3a00000001";
    const out = await runJob(
      { ...sampleJob({ prompt: "Say hello.\n", card: "You are the executor.\n" }), job_id: "c0ffee01-0000-4000-8000-5b3a00000001", run_id: runId, continues: null, model_hint: null },
      { sandbox: host, workspaces: createWorkspaceStore(workspaceRoot), ledger: createMemoryLedger(), credentials, envOptions, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet", wallClockMs: 90_000 },
    );
    const logText = readdirSync(logDir).map((name) => readFileSync(path.join(logDir, name), "utf8")).join("\n");
    process.stdout.write(`api key real-cli: outcome ${JSON.stringify(out)}\n`);

    // The init line came first, from the environment key.
    const stdout = readFileSync(path.join(logDir, `${runId}.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { kind: string; line: string })
      .filter((record) => record.kind === "stdout");
    const first = JSON.parse(stdout[0]!.line) as Record<string, unknown>;
    expect(isInitLine(first)).toBe(true);
    expect(first.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(initCredentialMatches("api_key", first)).toBe(true);

    // The authentication failure is a closed reason of the runner, not a success and not free text.
    expect(out.status).toBe("failed");
    expect((out as { reason: string }).reason).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    expect(["agent_error", "auth_missing"]).toContain((out as { reason: string }).reason);
    expect(logText).not.toContain("THISKEYISINVALID");
  });
});
