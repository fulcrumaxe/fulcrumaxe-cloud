import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeArgv } from "../src/engines/claude/argv.js";
import { confineFileTools } from "../src/engines/claude/filePermissions.js";
import { writeJobFiles } from "../src/engines/claude/settingsFile.js";
import { roleToolsFor } from "../src/job/roleTools.js";
import { protectedPaths } from "../src/sandbox/sandboxSettings.js";
import { FakeMessagesApi, type ScriptedCall } from "./canary/fakeMessagesApi.js";

/**
 * D#6 RUNNER-AGENT-NO-FULLCHECK, real contract: the installed agent CLI against the settings file the runner's own writer produces for a job whose approved
 * check is `bash scripts/check.sh`, started with the runner's own argument list for a review role (plain `Bash`, `dontAsk`).
 *
 * OPT-IN, like `excludes.live.test.ts`: skipped unless `FX_RUNNER_CHECKDENY_LIVE=1` and `FX_CLAUDE_BIN` names the CLI (an absolute path), and always skipped
 * under `FX_FORBID_MODEL_CALLS=1`. It costs no model money: the CLI talks to a scripted loopback Messages API with a dummy key, in throwaway HOME and config
 * directories. Run by hand:
 *
 *     FX_RUNNER_CHECKDENY_LIVE=1 FX_CLAUDE_BIN=/abs/path/to/cli pnpm --filter @fulcrumaxe/fx-runner exec vitest run test/checkDeny.live.test.ts
 *
 * The shell sandbox block is left out (the scripts here only write a marker file in the throwaway workspace), so what is measured is the permission rules alone.
 * The check script writes a marker; a refused call leaves none. An unrelated script in the same folder runs, so the refusals are the rules' doing.
 */
const BIN = process.env.FX_CLAUDE_BIN ?? "";
const ON = process.env.FX_RUNNER_CHECKDENY_LIVE === "1" && BIN !== "" && process.env.FX_FORBID_MODEL_CALLS !== "1";
if (!ON) process.stdout.write("checkDeny.live: SKIPPED (set FX_RUNNER_CHECKDENY_LIVE=1 and FX_CLAUDE_BIN=<absolute path to the CLI>, with FX_FORBID_MODEL_CALLS unset)\n");

const CHECK_ARGV = ["bash", "scripts/check.sh"];
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runCli(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(BIN, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end("Run the scripted tool calls.\n");
  });
}

async function runOnCli(checkArgv: readonly string[] | undefined, script: (work: string) => ScriptedCall[][]): Promise<{ api: FakeMessagesApi; code: number | null; stderr: string; work: string }> {
  const base = mkdtempSync(path.join(tmpdir(), "fx-nofull-"));
  dirs.push(base);
  const work = path.join(base, "work");
  mkdirSync(path.join(work, "scripts"), { recursive: true });
  for (const [name, marker] of [["check.sh", "CHECK-RAN"], ["other.sh", "OTHER-RAN"]] as const) {
    const file = path.join(work, "scripts", name);
    writeFileSync(file, `#!/bin/sh\necho ${marker} > "$(dirname "$0")/../${marker}"\necho ${marker}\n`);
    chmodSync(file, 0o755);
  }
  const protectedList = protectedPaths({ home: path.join(base, "home"), stateDir: path.join(base, "home", ".fx-runner"), binaryDir: path.join(base, "bin") });
  const { settingsPath, mcpPath } = writeJobFiles(path.join(base, "jobs", "run"), work, "code-reviewer", {}, protectedList, [], undefined, checkArgv);
  const roleTools = roleToolsFor("code-reviewer");
  const argv = claudeArgv({ cliModel: "sonnet", roleTools, allowRules: confineFileTools(roleTools, path.resolve(work)), settingsPath, mcpPath });
  const api = new FakeMessagesApi(script(work));
  const baseUrl = await api.start();
  try {
    const home = path.join(base, "home");
    mkdirSync(home, { recursive: true });
    const out = await runCli(
      argv,
      { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CONFIG_DIR: path.join(base, "config"), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "fx-nofull-dummy-key-not-a-credential", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      work,
      150_000,
    );
    return { api, ...out, work };
  } finally {
    await api.stop();
  }
}

const bash = (id: string, command: string): ScriptedCall[] => [{ id, name: "Bash", input: { command, description: "run" } }];

describe.skipIf(!ON)("the approved check is denied to the agent's shell, on the real CLI (D#6 RUNNER-AGENT-NO-FULLCHECK)", () => {
  it("the check in each plain spelling, alone or in a pipeline or chain, is refused and never runs; another script runs", { timeout: 180_000 }, async () => {
    const out = await runOnCli(CHECK_ARGV, (work) => [
      bash("toolu_verbatim", "bash scripts/check.sh"),
      bash("toolu_piped", "bash scripts/check.sh 2>&1 | tail -100"),
      bash("toolu_grep", "bash scripts/check.sh 2>&1 | grep -E 'FAIL|passed'"),
      bash("toolu_chain", `cd ${work} && bash scripts/check.sh`),
      bash("toolu_direct", "./scripts/check.sh"),
      bash("toolu_sh", "sh scripts/check.sh | tail -5"),
      bash("toolu_other", "bash scripts/other.sh"),
    ]);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    const table = [...out.api.results].map(([id, r]) => `${id} isError=${r.isError} text=${JSON.stringify(r.text.slice(0, 200))}`).join("\n");
    process.stdout.write(`checkDeny.live: tool results by call id\n${table}\n`);
    for (const id of ["toolu_verbatim", "toolu_piped", "toolu_grep", "toolu_chain", "toolu_direct", "toolu_sh"]) {
      expect(out.api.results.get(id)?.isError, `${id}\n${table}`).toBe(true);
      expect(out.api.results.get(id)?.text, id).not.toContain("CHECK-RAN");
    }
    expect(existsSync(path.join(out.work, "CHECK-RAN")), table).toBe(false);
    expect(out.api.results.get("toolu_other")).toMatchObject({ isError: false });
    expect(existsSync(path.join(out.work, "OTHER-RAN"))).toBe(true);
  });

  it("a job without a check runs the same command (the rules are the only difference)", { timeout: 180_000 }, async () => {
    const out = await runOnCli(undefined, () => [bash("toolu_verbatim", "bash scripts/check.sh")]);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    expect(out.api.results.get("toolu_verbatim")).toMatchObject({ isError: false });
    expect(existsSync(path.join(out.work, "CHECK-RAN"))).toBe(true);
  });
});
