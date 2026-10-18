import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BASH_MAX_OUTPUT_LENGTH } from "@fulcrumaxe/runner-protocol";
import { agentSettingsFor } from "../src/agentConfig.js";
import { buildSandboxEnv } from "../src/sandboxEnv.js";
import { FakeMessagesApi, type ScriptedCall } from "./helpers/scriptedMessagesApi.js";

/**
 * D#600 CX-6a, real contract: the installed `claude` CLI against the Bash-output lever the sandbox env sets.
 *
 * OPT-IN. It starts the real program, so it is skipped unless `FX_CONTEXT_LEVERS_LIVE=1` and `FX_CLAUDE_BIN` names the CLI (an absolute path), and always
 * skipped under `FX_FORBID_MODEL_CALLS=1`. It costs no model money: the CLI talks to a scripted loopback Messages API (the same technique as
 * contextRules.live.test.ts) with a dummy key, and its HOME and config directory are throwaway directories, so no login is found or used. Run by hand:
 *
 *     FX_CONTEXT_LEVERS_LIVE=1 FX_CLAUDE_BIN=/abs/path/to/claude pnpm --filter @fx/runner exec vitest run test/contextLevers.live.test.ts
 *
 * Without the flags the reason for the skip is printed, so a skip is never read as a pass.
 *
 * The script is one run of several Bash calls, each printing N characters (8,000, 12,000, 20,000 and 100,000), run twice: once with the sandbox's limit
 * (30,000) and once with a control limit (5,000). The text the CLI sends the (scripted) model back is measured and classified:
 *   full       the whole output came back;
 *   cut        the CLI cut it itself, to about the limit (it adds a short notice, so 300 characters of slack are allowed);
 *   persisted  CLI 2.1.302 writes output over the limit to a file under its config directory and returns a `<persisted-output>` block with a
 *              2 KB preview.
 * Observed with CLI 2.1.302: BASH_MAX_OUTPUT_LENGTH sets the size above which the CLI persists the output and returns the 2 KB preview; it never cuts. At
 * limit 30000 the 8k, 12k and 20k calls came back full and the 100k one was persisted; at 5000 all of them were persisted. So any output over the limit reaches
 * the model as at most limit + slack, either as a cut or as a persisted preview, and both are accepted (the mode is printed).
 * The proof that the variable is honoured: a size at or under 30,000 comes back full at 30,000 and NOT full (cut or persisted) at 5,000. At least one of the
 * mid sizes must show that pair, else the lever is not proven. Nothing at or under the limit may be cut at the 30,000 limit.
 */
const BIN = process.env.FX_CLAUDE_BIN ?? "";
const ON = process.env.FX_CONTEXT_LEVERS_LIVE === "1" && BIN !== "" && process.env.FX_FORBID_MODEL_CALLS !== "1";
if (!ON) process.stdout.write("contextLevers.live: SKIPPED (set FX_CONTEXT_LEVERS_LIVE=1 and FX_CLAUDE_BIN=<absolute path to claude>, with FX_FORBID_MODEL_CALLS unset, to run the installed CLI)\n");

const NOTICE_SLACK = 300;
const SIZES = [8_000, 12_000, 20_000, 100_000] as const;
const MID_SIZES = [8_000, 12_000, 20_000] as const;
type Mode = "full" | "cut" | "persisted";
const modeOf = (text: string, size: number): Mode => (text.includes("<persisted-output>") ? "persisted" : text.length >= size ? "full" : "cut");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

/** Runs one Bash call per size with `limit` as BASH_MAX_OUTPUT_LENGTH and returns, per size, the length of the text the CLI sent back to the model and its mode. */
async function bashResults(limit: string): Promise<Map<number, { length: number; mode: Mode; isError: boolean }>> {
  const base = mkdtempSync(path.join(tmpdir(), "fx-cx6a-"));
  dirs.push(base);
  const work = path.join(base, "work");
  const home = path.join(base, "home");
  mkdirSync(work, { recursive: true });
  mkdirSync(home, { recursive: true });
  const settingsPath = path.join(base, "settings.json");
  const mcpPath = path.join(base, "mcp.json");
  // The production settings for the executor role, less the runner's hook (its script lives at /fx/ in a sandbox).
  writeFileSync(settingsPath, JSON.stringify({ ...agentSettingsFor("executor"), hooks: {} }));
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
  const script: ScriptedCall[][] = SIZES.map((n) => [{ id: `toolu_${n}`, name: "Bash", input: { command: `head -c ${n} /dev/zero | tr '\\0' 'x'`, description: `print ${n} characters` } }]);
  const api = new FakeMessagesApi(script);
  const baseUrl = await api.start();
  let out: Awaited<ReturnType<typeof runCli>>;
  try {
    out = await runCli(
      ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--settings", settingsPath, "--strict-mcp-config", "--mcp-config", mcpPath, "--max-turns", "5", "--model", "sonnet"],
      {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(base, "config"),
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: "fx-cx6a-dummy-key-not-a-credential",
        BASH_MAX_OUTPUT_LENGTH: limit,
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
  const streamFile = path.join(tmpdir(), `fx-cx6a-stream-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(streamFile, out.stdout);
  process.stdout.write(`contextLevers.live: limit=${limit} raw stream-json: ${streamFile}\n`);
  expect(out.code, out.stderr.slice(0, 500)).toBe(0);
  const table = new Map<number, { length: number; mode: Mode; isError: boolean }>();
  for (const n of SIZES) {
    const r = api.results.get(`toolu_${n}`);
    expect(r, `the ${n}-character Bash call has a result; raw stream: ${streamFile}`).toBeDefined();
    const row = { length: r!.text.length, mode: modeOf(r!.text, n), isError: r!.isError };
    table.set(n, row);
    process.stdout.write(`contextLevers.live: limit=${limit} printed=${n} returned=${row.length} mode=${row.mode} isError=${row.isError}\n`);
  }
  return table;
}

describe.skipIf(!ON)("Bash output limit against the real CLI (D#600 CX-6a)", () => {
  it("acceptance 3: a 100 KB Bash call returns at most the configured length (cut) or a persisted-output block; a size at or under 30,000 is full at 30,000 and not full (cut or persisted) at 5,000", { timeout: 600_000 }, async () => {
    // The value comes from the sandbox env the runner builds, so a change there is a change here.
    const configured = buildSandboxEnv("executor").BASH_MAX_OUTPUT_LENGTH;
    expect(configured).toBe(String(BASH_MAX_OUTPUT_LENGTH));
    const real = await bashResults(configured!);
    const control = await bashResults("5000");
    for (const t of [real, control]) for (const row of t.values()) expect(row.isError).toBe(false);

    // The 100 KB call: cut to the limit, or persisted with its 2 KB preview. Never the whole output.
    const big = real.get(100_000)!;
    expect(big.mode, "100 KB is never returned whole").not.toBe("full");
    expect(big.length).toBeLessThanOrEqual(BASH_MAX_OUTPUT_LENGTH + NOTICE_SLACK);
    expect(big.length, "something was returned, not nothing").toBeGreaterThan(1_000);
    const bigControl = control.get(100_000)!;
    expect(bigControl.mode).not.toBe("full");
    expect(bigControl.length).toBeLessThanOrEqual(5_000 + NOTICE_SLACK);

    // Mid sizes (under the limit of 30,000): never cut at 30,000; and at 5,000 never above the limit plus slack unless persisted.
    let proven = 0;
    for (const n of MID_SIZES) {
      const a = real.get(n)!;
      const b = control.get(n)!;
      expect(a.mode, `${n} at limit 30000`).not.toBe("cut");
      if (b.mode !== "persisted") expect(b.length, `${n} at limit 5000`).toBeLessThanOrEqual(5_000 + NOTICE_SLACK);
      if (a.mode === "full" && b.mode !== "full") proven += 1;
    }
    expect(proven, "at least one size is returned full at 30000 and not full (cut or persisted) at 5000: that is the variable being honoured").toBeGreaterThanOrEqual(1);
  });
});
