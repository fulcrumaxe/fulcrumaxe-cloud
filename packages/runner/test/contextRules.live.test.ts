import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ContextLedgerCapture } from "@fulcrumaxe/runner-protocol";
import { agentSettingsFor, disabledToolsFor, excludeDenyRules } from "../src/agentConfig.js";
import { FakeMessagesApi, type ScriptedCall } from "./helpers/scriptedMessagesApi.js";

/**
 * D#600 CX-5b, real contract: the installed `claude` CLI against the deny entries `agentSettingsFor` writes for a run's excludes.
 *
 * OPT-IN. It starts the real program, so it is skipped unless `FX_CONTEXT_RULES_LIVE=1` and `FX_CLAUDE_BIN` names the CLI (an absolute path), and
 * always skipped under `FX_FORBID_MODEL_CALLS=1`. It costs no model money: the CLI talks to a scripted loopback Messages API (the same technique as the
 * runner daemon's canary, packages/fx-runner/test/canary) with a dummy key, and its HOME and config directory are throwaway directories, so no login
 * is found or used. Our policy is that nothing cost-bearing runs by itself; this is run by hand:
 *
 *     FX_CONTEXT_RULES_LIVE=1 FX_CLAUDE_BIN=/abs/path/to/claude pnpm --filter @fx/runner exec vitest run test/contextRules.live.test.ts
 *
 * Without the flags the reason for the skip is printed, so a skip is never read as a pass. It is the only check that the CLI's own rule matching
 * agrees with `escapeRulePath` (the CLI documents `[ ] { } ( )` as pattern syntax; the runner writes them as literals), and the only one of the shape
 * of the CLI's permission refusal that `ContextLedgerCapture` counts. Run it again when the pinned CLI version changes.
 *
 * The script, one tool call per step, against a workspace holding:
 *   secret/a.txt  (excluded by path)          keys/k.txt  (excluded as a folder: `keys`)
 *   src/x/a.ts denied and src/x/c.ts read   (an exclude glob with a character class)
 *   app/[id]/page.tsx denied by a LITERAL rule (brackets are file-name characters) and app/i/page.tsx read
 *   (group)/c.txt  (excluded; parentheses are escaped)         public/b.txt  (not excluded)
 * plus a Grep and a Glob, which the bare deny entries turn off.
 */
const BIN = process.env.FX_CLAUDE_BIN ?? "";
const ON = process.env.FX_CONTEXT_RULES_LIVE === "1" && BIN !== "" && process.env.FX_FORBID_MODEL_CALLS !== "1";
if (!ON) process.stdout.write("contextRules.live: SKIPPED (set FX_CONTEXT_RULES_LIVE=1 and FX_CLAUDE_BIN=<absolute path to claude>, with FX_FORBID_MODEL_CALLS unset, to run the installed CLI)\n");

const SENTINEL = "FX-CX5B-SENTINEL-9f2c41d7";
// Excludes keep full glob syntax: `src/**/[ab].ts` has a character class. A literal path (a pin's, or any exact path) is escaped: `app/[id]/page.tsx` is one file.
const EXCLUDES = ["secret/a.txt", "keys", "src/**/[ab].ts", "(group)/c.txt"];
const LITERALS = ["app/[id]/page.tsx"];
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function file(root: string, rel: string, text: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

/** Splits the request bodies the CLI sent into the JSON of every tool_use block (the scripted model's own calls) and the JSON of everything else, tool_result blocks included. */
function splitRequests(raw: readonly string[]): { toolUseInputs: string[]; everythingElse: string[] } {
  const toolUseInputs: string[] = [];
  const everythingElse: string[] = [];
  for (const body of raw) {
    let parsed: { messages?: unknown; [k: string]: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      everythingElse.push(body);
      continue;
    }
    const { messages, ...rest } = parsed;
    everythingElse.push(JSON.stringify(rest));
    for (const m of Array.isArray(messages) ? (messages as Array<{ content?: unknown; [k: string]: unknown }>) : []) {
      if (!Array.isArray(m.content)) {
        everythingElse.push(JSON.stringify(m));
        continue;
      }
      for (const block of m.content as Array<{ type?: unknown }>) (block.type === "tool_use" ? toolUseInputs : everythingElse).push(JSON.stringify(block));
    }
  }
  return { toolUseInputs, everythingElse };
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

describe.skipIf(!ON)("excludes against the real CLI (D#600 CX-5b)", () => {
  it("acceptance 1: reads of excluded paths are refused (also with [ ] ( ) in the name, and under an excluded folder), an ordinary read is not, Grep and Glob are off, and the count is one per refused call", { timeout: 180_000 }, async () => {
    const base = mkdtempSync(path.join(tmpdir(), "fx-cx5b-"));
    dirs.push(base);
    const work = path.join(base, "work");
    const abs = {
      secret: file(work, "secret/a.txt", `${SENTINEL}-secret\n`),
      keys: file(work, "keys/k.txt", `${SENTINEL}-keys\n`),
      bracket: file(work, "app/[id]/page.tsx", `${SENTINEL}-bracket\n`),
      globA: file(work, "src/x/a.ts", `${SENTINEL}-globA\n`),
      globC: file(work, "src/x/c.ts", "GLOB-C-OK\n"),
      bracketSibling: file(work, "app/i/page.tsx", "SIBLING-OK\n"),
      paren: file(work, "(group)/c.txt", `${SENTINEL}-paren\n`),
      open: file(work, "public/b.txt", "PUBLIC-OK\n"),
    };
    // The settings are the production ones for the executor role, less the runner's hook (its script lives at /fx/ in a sandbox).
    const withExcludes = agentSettingsFor("executor", EXCLUDES) as { permissions: { deny: string[] } };
    const literalRules = excludeDenyRules(LITERALS, "literal").filter((r) => r.startsWith("Read("));
    const settings = { ...withExcludes, permissions: { ...withExcludes.permissions, deny: [...withExcludes.permissions.deny, ...literalRules] }, hooks: {} };
    const settingsPath = path.join(base, "settings.json");
    const mcpPath = path.join(base, "mcp.json");
    writeFileSync(settingsPath, JSON.stringify(settings));
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));

    const script: ScriptedCall[][] = [
      [{ id: "toolu_secret", name: "Read", input: { file_path: abs.secret } }],
      [{ id: "toolu_keys", name: "Read", input: { file_path: abs.keys } }],
      [{ id: "toolu_bracket", name: "Read", input: { file_path: abs.bracket } }],
      [{ id: "toolu_paren", name: "Read", input: { file_path: abs.paren } }],
      [{ id: "toolu_globA", name: "Read", input: { file_path: abs.globA } }],
      [{ id: "toolu_globC", name: "Read", input: { file_path: abs.globC } }],
      [{ id: "toolu_sibling", name: "Read", input: { file_path: abs.bracketSibling } }],
      [{ id: "toolu_grep", name: "Grep", input: { pattern: SENTINEL, path: work } }],
      [{ id: "toolu_glob", name: "Glob", input: { pattern: "**/*.txt", path: work } }],
      [{ id: "toolu_open", name: "Read", input: { file_path: abs.open } }],
    ];
    const api = new FakeMessagesApi(script);
    const baseUrl = await api.start();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      const home = path.join(base, "home");
      mkdirSync(home, { recursive: true });
      out = await runCli(
        ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--settings", settingsPath, "--strict-mcp-config", "--mcp-config", mcpPath, "--max-turns", "20", "--model", "sonnet"],
        {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CLAUDE_CONFIG_DIR: path.join(base, "config"),
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: "fx-cx5b-dummy-key-not-a-credential",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        work,
        150_000,
      );
    } finally {
      await api.stop();
    }
    // The raw stream-json of the run is kept (outside the test's own directory, which is removed) and its path printed, so a failure can be read at once.
    const streamFile = path.join(tmpdir(), `fx-cx5b-stream-${process.pid}-${Date.now()}.jsonl`);
    writeFileSync(streamFile, out.stdout);
    process.stdout.write(`contextRules.live: raw stream-json of the run: ${streamFile}\n`);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);

    // The sentinel reached no tool result and no other content the CLI sent to the (scripted) API. The scripted Grep call's own INPUT holds it (the CLI echoes
    // the model's tool_use back as conversation history), so requests are parsed and tool_use blocks are set apart rather than searched as text.
    const { toolUseInputs, everythingElse } = splitRequests(api.rawRequests);
    expect(toolUseInputs.some((i) => i.includes(SENTINEL)), "positive control: the Grep pattern is in a tool_use input").toBe(true);
    expect(everythingElse.filter((t) => t.includes(SENTINEL))).toEqual([]);
    for (const id of ["toolu_secret", "toolu_keys", "toolu_bracket", "toolu_paren", "toolu_globA", "toolu_grep", "toolu_glob"]) {
      const r = api.results.get(id);
      expect(r, id).toBeDefined();
      expect(r!.isError, id).toBe(true);
      expect(r!.text, id).not.toContain(SENTINEL);
    }
    // An ordinary file in the same workspace is read: the refusals are the rules' doing, not the run's.
    // The glob denied src/x/a.ts and not src/x/c.ts; the literal rule denied the bracketed folder and not its sibling.
    expect(api.results.get("toolu_globC")).toMatchObject({ isError: false });
    expect(api.results.get("toolu_globC")!.text).toContain("GLOB-C-OK");
    expect(api.results.get("toolu_sibling")).toMatchObject({ isError: false });
    expect(api.results.get("toolu_sibling")!.text).toContain("SIBLING-OK");
    expect(api.results.get("toolu_open")).toMatchObject({ isError: false });
    expect(api.results.get("toolu_open")!.text).toContain("PUBLIC-OK");

    // The counter reads the refusals from the real stream: every refused call once, the ordinary read not at all.
    const capture = new ContextLedgerCapture(disabledToolsFor(EXCLUDES));
    for (const line of out.stdout.split("\n")) {
      if (line.trim() === "") continue;
      try {
        capture.observe(JSON.parse(line));
      } catch {
        // not every line of the stream is JSON; only the JSON lines are observed
      }
    }
    // On a miss the message lists every scripted call with its error flag and the exact text the CLI answered, so the refusal wordings can be read off.
    const table = [...api.results].map(([id, r]) => `${id} isError=${r.isError} text=${JSON.stringify(r.text.slice(0, 300))}`).join("\n");
    process.stdout.write(`contextRules.live: tool results by call id\n${table}\ncounted refusals: ${capture.deniedToolCalls()}\n`);
    expect(capture.deniedToolCalls(), `each call's result text:\n${table}\nraw stream: ${streamFile}`).toBeGreaterThanOrEqual(1);
    expect(capture.deniedToolCalls(), `each call's result text:\n${table}\nraw stream: ${streamFile}`).toBe(7);
  });

  it("with no excludes the same script reads every file and the count is 0 (the deny list is empty, as for a run without rules)", { timeout: 180_000 }, async () => {
    const base = mkdtempSync(path.join(tmpdir(), "fx-cx5b-"));
    dirs.push(base);
    const work = path.join(base, "work");
    const target = file(work, "secret/a.txt", `${SENTINEL}-secret\n`);
    const settingsPath = path.join(base, "settings.json");
    const mcpPath = path.join(base, "mcp.json");
    writeFileSync(settingsPath, JSON.stringify({ ...agentSettingsFor("executor"), hooks: {} }));
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    const api = new FakeMessagesApi([[{ id: "toolu_secret", name: "Read", input: { file_path: target } }]]);
    const baseUrl = await api.start();
    let out: Awaited<ReturnType<typeof runCli>>;
    try {
      const home = path.join(base, "home");
      mkdirSync(home, { recursive: true });
      out = await runCli(
        ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--settings", settingsPath, "--strict-mcp-config", "--mcp-config", mcpPath, "--max-turns", "5", "--model", "sonnet"],
        { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CONFIG_DIR: path.join(base, "config"), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "fx-cx5b-dummy-key-not-a-credential", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        work,
        150_000,
      );
    } finally {
      await api.stop();
    }
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    expect(api.results.get("toolu_secret")).toMatchObject({ isError: false });
    expect(api.results.get("toolu_secret")!.text).toContain(SENTINEL);
    const capture = new ContextLedgerCapture();
    for (const line of out.stdout.split("\n")) {
      try {
        capture.observe(JSON.parse(line));
      } catch {
        // not every line of the stream is JSON
      }
    }
    expect(capture.deniedToolCalls()).toBe(0);
  });
});
