import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ContextLedgerCapture, disabledToolsFor } from "@fulcrumaxe/runner-protocol";
import { claudeArgv } from "../src/engines/claude/argv.js";
import { confineFileTools } from "../src/engines/claude/filePermissions.js";
import { writeJobFiles } from "../src/engines/claude/settingsFile.js";
import { roleToolsFor } from "../src/job/roleTools.js";
import { protectedPaths } from "../src/sandbox/sandboxSettings.js";
import { FakeMessagesApi, type ScriptedCall } from "./canary/fakeMessagesApi.js";

/**
 * D#600 CX-5c, real contract: the installed `claude` CLI against the settings file the RUNNER's own writer (`writeJobFiles`) produces for a job's `excludes`,
 * started with the runner's own argument list (`claudeArgv`: `--settings`, `--tools`, `--allowedTools` confined to the workspace, `--permission-prompts none`).
 *
 * OPT-IN. It starts the real program, so it is skipped unless `FX_RUNNER_EXCLUDES_LIVE=1` and `FX_CLAUDE_BIN` names the CLI (an absolute path), and always
 * skipped under `FX_FORBID_MODEL_CALLS=1`. It costs no model money: the CLI talks to a scripted loopback Messages API (this directory's canary helper) with a dummy
 * key, and its HOME and config directory are throwaway directories, so no login is found or used. Our policy is that nothing cost-bearing runs by itself; this
 * is run by hand:
 *
 *     FX_RUNNER_EXCLUDES_LIVE=1 FX_CLAUDE_BIN=/abs/path/to/claude pnpm --filter @fulcrumaxe/fx-runner exec vitest run test/excludes.live.test.ts
 *
 * Without the flags the reason for the skip is printed, so a skip is never read as a pass. Two things differ from a production run, and only these:
 * the base URL and the dummy key (the production environment builder refuses `ANTHROPIC_BASE_URL`, so the CLI is started directly here), and the shell sandbox
 * block, which is left out because no Bash call is scripted. Run it again when the pinned CLI version changes.
 *
 * Workspace, and the script (one tool call per step): the same files the cloud sandbox's live test uses, so the two can be compared.
 *   secret/a.txt (excluded by path)   keys/k.txt (excluded as the folder `keys`)   src/x/a.ts denied and src/x/c.ts read (glob with a character class)
 *   (group)/c.txt (excluded; parentheses are escaped)   public/b.txt (not excluded)   plus a Grep and a Glob, which the bare deny entries turn off.
 */
const BIN = process.env.FX_CLAUDE_BIN ?? "";
const ON = process.env.FX_RUNNER_EXCLUDES_LIVE === "1" && BIN !== "" && process.env.FX_FORBID_MODEL_CALLS !== "1";
if (!ON) process.stdout.write("excludes.live: SKIPPED (set FX_RUNNER_EXCLUDES_LIVE=1 and FX_CLAUDE_BIN=<absolute path to claude>, with FX_FORBID_MODEL_CALLS unset, to run the installed CLI)\n");

const SENTINEL = "FX-CX5C-SENTINEL-4a8e61d2";
const EXCLUDES = ["secret/a.txt", "keys", "src/**/[ab].ts", "(group)/c.txt"];
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function file(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function runCli(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(BIN, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end("Run the scripted tool calls.\n");
  });
}

interface Ran {
  api: FakeMessagesApi;
  code: number | null;
  stderr: string;
  streamLines: unknown[];
}

/** Lays out `files` in a fresh workspace, writes the settings with the runner's own writer, starts the CLI with the runner's own argument list and plays `script` against it. */
async function runOnCli(excludes: readonly string[], files: Record<string, string>, script: (abs: (rel: string) => string, work: string) => ScriptedCall[][]): Promise<Ran> {
  const base = mkdtempSync(path.join(tmpdir(), "fx-cx5c-"));
  dirs.push(base);
  const work = path.join(base, "work");
  for (const [rel, text] of Object.entries(files)) file(work, rel, text);
  // The runner's own writer, in its own job directory outside the workspace; the shell sandbox block is left out (no Bash call is scripted).
  const protectedList = protectedPaths({ home: path.join(base, "home"), stateDir: path.join(base, "home", ".fx-runner"), binaryDir: path.join(base, "bin") });
  const { settingsPath, mcpPath } = writeJobFiles(path.join(base, "jobs", "run"), work, "executor", {}, protectedList, excludes);
  const roleTools = roleToolsFor("executor");
  const argv = claudeArgv({ cliModel: "sonnet", roleTools, allowRules: confineFileTools(roleTools, path.resolve(work)), settingsPath, mcpPath });
  const api = new FakeMessagesApi(script((rel) => path.join(work, rel), work));
  const baseUrl = await api.start();
  try {
    const home = path.join(base, "home");
    mkdirSync(home, { recursive: true });
    const out = await runCli(
      argv,
      { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CONFIG_DIR: path.join(base, "config"), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "fx-cx5c-dummy-key-not-a-credential", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      work,
      150_000,
    );
    const streamLines: unknown[] = [];
    for (const line of out.stdout.split("\n")) {
      if (line.trim() === "") continue;
      try {
        streamLines.push(JSON.parse(line));
      } catch {
        // not every line of the stream is JSON; only the JSON lines are observed
      }
    }
    // The raw stream-json is kept (outside the test's own directory, which is removed) and its path printed, so a failure can be read at once.
    const streamFile = path.join(tmpdir(), `fx-cx5c-stream-${process.pid}-${Date.now()}.jsonl`);
    writeFileSync(streamFile, out.stdout);
    process.stdout.write(`excludes.live: raw stream-json of the run: ${streamFile}\n`);
    return { api, code: out.code, stderr: out.stderr, streamLines };
  } finally {
    await api.stop();
  }
}

describe.skipIf(!ON)("a job's excludes against the real CLI on the runner path (D#600 CX-5c)", () => {
  it("acceptance 4: reads of excluded paths are refused (also with ( ) in the name and under an excluded folder), an ordinary read is not, Grep and Glob are off, the sentinel never reaches the API, and the count is one per refused call", { timeout: 180_000 }, async () => {
    const files = {
      "secret/a.txt": `${SENTINEL}-secret\n`,
      "keys/k.txt": `${SENTINEL}-keys\n`,
      "src/x/a.ts": `${SENTINEL}-globA\n`,
      "src/x/c.ts": "GLOB-C-OK\n",
      "(group)/c.txt": `${SENTINEL}-paren\n`,
      "public/b.txt": "PUBLIC-OK\n",
    };
    const read = (id: string, rel: string, abs: (rel: string) => string): ScriptedCall[] => [{ id, name: "Read", input: { file_path: abs(rel) } }];
    const out = await runOnCli(EXCLUDES, files, (abs, work) => [
      read("toolu_secret", "secret/a.txt", abs),
      read("toolu_keys", "keys/k.txt", abs),
      read("toolu_paren", "(group)/c.txt", abs),
      read("toolu_globA", "src/x/a.ts", abs),
      read("toolu_globC", "src/x/c.ts", abs),
      [{ id: "toolu_grep", name: "Grep", input: { pattern: SENTINEL, path: work } }],
      [{ id: "toolu_glob", name: "Glob", input: { pattern: "**/*.txt", path: work } }],
      read("toolu_open", "public/b.txt", abs),
    ]);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);

    const results = out.api.results;
    for (const id of ["toolu_secret", "toolu_keys", "toolu_paren", "toolu_globA", "toolu_grep", "toolu_glob"]) {
      const r = results.get(id);
      expect(r, id).toBeDefined();
      expect(r!.isError, id).toBe(true);
      expect(r!.text, id).not.toContain(SENTINEL);
    }
    // An ordinary file in the same workspace is read: the refusals are the rules' doing, not the run's. The glob denied src/x/a.ts and not src/x/c.ts.
    expect(results.get("toolu_globC")).toMatchObject({ isError: false });
    expect(results.get("toolu_globC")!.text).toContain("GLOB-C-OK");
    expect(results.get("toolu_open")).toMatchObject({ isError: false });
    expect(results.get("toolu_open")!.text).toContain("PUBLIC-OK");
    // The sentinel is in no request the CLI sent, apart from the scripted Grep call's own pattern (echoed back as history), so tool_use blocks are set apart.
    const everythingElse = out.api.rawRequests.flatMap((raw) => {
      try {
        const { messages, ...rest } = JSON.parse(raw) as { messages?: Array<{ content?: unknown }>; [k: string]: unknown };
        const blocks = (messages ?? []).flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : [])).filter((b) => b.type !== "tool_use");
        return [JSON.stringify(rest), ...blocks.map((b) => JSON.stringify(b))];
      } catch {
        return [raw];
      }
    });
    expect(everythingElse.filter((t) => t.includes(SENTINEL))).toEqual([]);

    // The daemon's counter, fed the real stream: every refused call once, the ordinary reads not at all.
    const capture = new ContextLedgerCapture(disabledToolsFor(EXCLUDES));
    for (const line of out.streamLines) capture.observe(line);
    const table = [...results].map(([id, r]) => `${id} isError=${r.isError} text=${JSON.stringify(r.text.slice(0, 300))}`).join("\n");
    process.stdout.write(`excludes.live: tool results by call id\n${table}\ncounted refusals: ${capture.deniedToolCalls()}\n`);
    expect(capture.deniedToolCalls(), `each call's result text:\n${table}`).toBe(6);
  });

  it("with no excludes the same read of the same file succeeds and the count is 0 (the settings carry no deny entries beyond the protected floor)", { timeout: 180_000 }, async () => {
    const out = await runOnCli([], { "secret/a.txt": `${SENTINEL}-secret\n` }, (abs) => [[{ id: "toolu_secret", name: "Read", input: { file_path: abs("secret/a.txt") } }]]);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    expect(out.api.results.get("toolu_secret")).toMatchObject({ isError: false });
    expect(out.api.results.get("toolu_secret")!.text).toContain(SENTINEL);
    const capture = new ContextLedgerCapture();
    for (const line of out.streamLines) capture.observe(line);
    expect(capture.deniedToolCalls()).toBe(0);
  });
});
