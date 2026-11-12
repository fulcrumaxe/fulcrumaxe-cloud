import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS, DEPLOY_VERIFIER_ROLE, FXVERIFY_TOOL_PREFIX } from "@fulcrumaxe/runner-protocol";
import { mcpConfigFor, type VerifyServerSpec } from "../../src/engines/claude/settingsFile.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749: the `fxverify` entry the engine writes into a job's MCP file must start a server that answers, for EVERY shape of entry `mcpConfigFor` writes, the protection bypass pair
 * included. The program is bundled the way a plain release is and started with the entry's own command and arguments, as the Claude CLI starts it; nothing in between is faked.
 * Before this test the CLI's flag table did not know `--bypass-file` and `--cloud-origin`, so on a runner with a bypass file the server exited at once ("unknown option"), the CLI
 * reported it `failed` in its init line and the deploy verifier ran with no browser tools at all. No browser is needed: the browser starts on the first journey, never at start-up.
 */
const RUN = "6b1d2f0e-4c3a-4e5b-9a7d-1f2e3d4c5b6a";
const FAKE = "fake-bypass-value-0123456789";
let work = "";
let home = "";
let bundle = "";

beforeAll(() => {
  work = mkdtempSync(path.join(tmpRoot(), "pw-flags-"));
  home = path.join(work, "home");
  mkdirSync(path.join(home, ".fx-runner"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, ".fx-runner", "bypass"), `${FAKE}\n`, { mode: 0o600 });
  bundle = path.join(work, "fx-runner.cjs");
  buildSync({ entryPoints: [path.join(PACKAGE_DIR, "bin", "fx-runner.mjs")], absWorkingDir: PACKAGE_DIR, bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle, logLevel: "silent", external: ["@anthropic-ai/*", "playwright-core"], define: { "import.meta.url": JSON.stringify(pathToFileURL(bundle).href), __FX_BUILD_EPOCH__: '"0"' } });
}, 60_000);

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

/** Starts the entry, sends initialize and tools/list, closes its input and returns what it answered, its stderr and its exit code. */
async function talk(spec: VerifyServerSpec): Promise<{ tools: string[]; stderr: string; code: number | null; args: string[] }> {
  const jobDir = path.join(work, "jobs", RUN);
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const entry = mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" }, jobDir, spec).mcpServers["fxverify"] as { command: string; args: string[]; env: Record<string, string> };
  const child = spawn(entry.command, entry.args, { env: { ...entry.env, PATH: process.env.PATH ?? "", HOME: home, NODE_PATH: path.join(PACKAGE_DIR, "node_modules") }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => void (out += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => void (err += c));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  child.stdin.on("error", () => undefined);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  // The input stays open until both answers are in (or the server is gone), then closing it ends the server.
  for (let i = 0; i < 200 && !out.includes('"id":2'); i++) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.stdin.end();
  const code = await exited;
  const list = out.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { id: number; result?: { tools?: Array<{ name: string }> } }).find((m) => m.id === 2);
  return { tools: (list?.result?.tools ?? []).map((t) => `${FXVERIFY_TOOL_PREFIX}${t.name}`), stderr: err, code, args: entry.args };
}

describe("the fxverify entry as the engine writes it starts a server that lists its tools", () => {
  const spec = (): VerifyServerSpec => ({ command: process.execPath, args: [bundle], baseUrl: "https://app.example.test", executable: process.execPath, storageState: path.join(home, ".config", "fx-runner", "verify", "storage-state.json") });

  it("without the protection bypass", async () => {
    const r = await talk(spec());
    expect(r.args).not.toContain("--bypass-file");
    expect(r.stderr).toBe("");
    expect(r.tools.sort()).toEqual([...DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS].sort());
    expect(r.code).toBe(0);
  }, 30_000);

  it("with the protection bypass pair (the entry every runner with a bypass file writes for the cloud origin)", async () => {
    const r = await talk({ ...spec(), bypassFile: path.join(home, ".fx-runner", "bypass"), cloudOrigin: "https://app.example.test" });
    expect(r.args.slice(-4)).toEqual(["--bypass-file", path.join(home, ".fx-runner", "bypass"), "--cloud-origin", "https://app.example.test"]);
    expect(r.stderr).not.toMatch(/unknown option/);
    expect(r.stderr).toBe("");
    expect(r.tools.sort()).toEqual([...DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS].sort());
    expect(r.code).toBe(0);
    expect(r.stderr + r.tools.join("")).not.toContain(FAKE);
  }, 30_000);
});
