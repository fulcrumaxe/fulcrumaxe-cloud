import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS, DEPLOY_VERIFIER_ROLE, FXVERIFY_TOOL_PREFIX } from "@fulcrumaxe/runner-protocol";
import { readVerifyAnswer } from "../../src/daemon/answerFile.js";
import { mcpConfigFor } from "../../src/engines/claude/settingsFile.js";
import { findChromium } from "../../src/verifyBrowser/driver.js";
import { PACKAGE_DIR } from "../helpers/srcFiles.js";
import { chromiumSandboxRefused } from "../helpers/chromiumSandbox.js";
import { tmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2c-2b: the runner-side end to end, WITHOUT the claude CLI. The program is bundled the way a plain (non-single-executable) release is, with the Playwright library left out. The
 * MCP entry is then the one `mcpConfigFor` writes into the job's MCP file, started with its own command and arguments and an environment of the engine's kind (a short allowlist, no token),
 * as a plain child of this test. The MCP tools are driven over its stdio against a page served on loopback, a real Chromium loads it, and the answer file the server writes is read back
 * by the daemon's own reader. While it runs, the server's process is inspected from outside: this is the "view" evidence for where the server runs (see the last test).
 * Skipped, with the reason named, when no Chromium is installed.
 */
const EXE = findChromium(process.env);
const NO_SANDBOX = chromiumSandboxRefused(EXE);
if (EXE === undefined) console.warn("SKIPPED verifyBrowser entry test: no Chromium found (PLAYWRIGHT_BROWSERS_PATH unset or empty, no google-chrome or chromium on PATH)");

const RUN = "3f6c1a52-8d0e-4b7a-9c14-0a5e6d2b7f38";
let work = "";
let jobsDir = "";
let jobDir = "";
let bundle = "";
let app: Server;
let base = "";
let total = 3;
let child: ChildProcessWithoutNullStreams | undefined;
const waiting = new Map<number, (m: { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } }) => void>();
let nextId = 0;
let buffer = "";
const stderr: string[] = [];

const rpc = (method: string, params?: unknown) =>
  new Promise<{ result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } }>((resolve) => {
    nextId += 1;
    waiting.set(nextId, resolve);
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`);
  });
const call = async (name: string, args?: unknown) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? "", isError: r.result?.isError === true };
};
const refOf = (snapshot: string, name: string): string => new RegExp(`(e\\d+) [^\\n]*"${name}"`).exec(snapshot)?.[1] ?? "";

/** The namespaces of a process, by what `/proc/<pid>/ns/*` points at. */
const namespaces = (pid: number | string): Record<string, string> => Object.fromEntries(["mnt", "net", "user", "pid"].map((ns) => [ns, readlinkSync(`/proc/${pid}/ns/${ns}`)]));
const childrenOf = (pid: number): number[] =>
  readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .filter((n) => {
      try {
        return Number(readFileSync(`/proc/${n}/stat`, "utf8").replace(/^.*\) \S+ /, "").split(" ")[0]) === pid;
      } catch {
        return false;
      }
    })
    .map(Number);

beforeAll(async () => {
  if (EXE === undefined) return;
  work = mkdtempSync(path.join(tmpRoot(), "pw-entry-"));
  jobsDir = path.join(work, "jobs");
  jobDir = path.join(jobsDir, RUN);
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  // The program as a plain release bundles it: playwright-core is external, and import.meta.url is the bundle's own address.
  bundle = path.join(work, "fx-runner.cjs");
  buildSync({ entryPoints: [path.join(PACKAGE_DIR, "bin", "fx-runner.mjs")], absWorkingDir: PACKAGE_DIR, bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle, logLevel: "silent", external: ["@anthropic-ai/*", "playwright-core"], define: { "import.meta.url": JSON.stringify(pathToFileURL(bundle).href), __FX_BUILD_EPOCH__: '"0"' } });
  app = createServer((req, res) => {
    const cookie = req.headers.cookie ?? "";
    // The app's own identity route (the shell's session call): the signed-in user's login in `username`, only for the saved session's cookie.
    if (req.url === "/api/cloud/auth/me") {
      if (!cookie.includes("sid=test-account")) return void res.writeHead(401).end();
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ username: "octo-cat", email: "a@b.test", is_admin: true }));
    }
    if (req.url === "/inc" && req.method === "POST") {
      total += 1;
      return void res.writeHead(204).end();
    }
    if (!cookie.includes("sid=test-account")) return void res.writeHead(401, { "content-type": "text/html" }).end("<h1>Sign in</h1>");
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset=utf-8><h1>Orders</h1><p>Total: ${total}</p><button onclick="fetch('/inc',{method:'POST'}).then(()=>location.reload())">Add one</button>`);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const state = path.join(work, "storage-state.json");
  writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "test-account", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }), { mode: 0o600 });
  chmodSync(state, 0o600);

  // The entry exactly as the job's MCP file holds it.
  const entry = (mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" }, jobDir, { command: process.execPath, args: [bundle], baseUrl: base, executable: EXE, storageState: state }).mcpServers["fxverify"]) as { command: string; args: string[]; env: Record<string, string> };
  // The environment of the engine's kind: a short allowlist and no token. NODE_PATH is how this test lets the bundle find the library the release lays down as a sidecar.
  child = spawn(entry.command, entry.args, { env: { ...entry.env, PATH: process.env.PATH ?? "", NODE_PATH: path.join(PACKAGE_DIR, "node_modules") }, stdio: ["pipe", "pipe", "pipe"] });
  child.on("exit", (code, signal) => void stderr.push(`[exit ${String(code)} ${String(signal)}]`));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => void stderr.push(c));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const m = JSON.parse(line) as { id: number };
      waiting.get(m.id)?.(m as never);
    }
  });
}, 60_000);

afterAll(async () => {
  if (process.env.FX_DEBUG_ENTRY) console.log("DEBUG", stderr.join(""));
  child?.stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 500));
  child?.kill("SIGKILL");
  app?.close();
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe.skipIf(EXE === undefined)("the fxverify server started from the MCP entry, as the engine would start it", () => {
  it("advertises exactly the twelve tools of the playwright role table", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(init).toMatchObject({ result: { serverInfo: { name: "fxverify" } } });
    const names = (await rpc("tools/list")).result!.tools!.map((t) => `${FXVERIFY_TOOL_PREFIX}${t.name}`);
    expect([...names].sort()).toEqual([...DEPLOY_VERIFIER_PLAYWRIGHT_BROWSER_TOOLS].sort());
  });

  it.skipIf(NO_SANDBOX)("drives a real page through the tools and produces a grounded answer.json the daemon's reader accepts", async () => {
    expect((await call("begin_journey", { id: "orders" })).isError).toBe(false);
    expect((await call("open", { path: "/" })).text).toContain("opened");
    const before = await call("snapshot");
    expect(before.text).toContain("Total: 3");
    const button = refOf(before.text, "Add one");
    expect(button).not.toBe("");
    await call("click", { ref: button });
    expect((await call("wait_text", { text: "Total: 4" })).text).toBe("text_visible");
    await call("reload");
    const after = await call("snapshot");
    expect(after.text).toContain("Total: 4");

    // An invented fact and an invented number are refused, with the model free to fix and try again.
    const invented = { journeys: [{ id: "orders", result: "pass", steps: [{ did: "added one", dom_fact: "Total: 99", number: 99 }], console_errors: 0, undo_checked: false, reloaded: true }] };
    const refused = await call("submit_answer", { envelope: invented });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("answer_rejected");
    expect(existsSync(path.join(jobDir, "answer.json"))).toBe(false);

    const grounded = { journeys: [{ id: "orders", result: "pass", steps: [{ did: "added one and reloaded", dom_fact: "Total: 4", number: 4 }], console_errors: 0, undo_checked: false, reloaded: true }] };
    expect(await call("submit_answer", { envelope: grounded })).toEqual({ text: "answer accepted", isError: false });
    expect(statSync(path.join(jobDir, "answer.json")).mode & 0o777).toBe(0o600);
    // The daemon's reader takes that file as the job's answer, and the cookie of the storage state is what let the page load.
    // The server recorded the account itself, through the browser context's request API, which carried the saved session's cookie (the model never sent a signed_in_as).
    expect(JSON.parse(readFileSync(path.join(jobDir, "answer.json"), "utf8"))).toEqual({ ...grounded, signed_in_as: "octo-cat" });
    expect(readVerifyAnswer(jobsDir, RUN, process.getuid?.())).toEqual({ ...grounded, signed_in_as: "octo-cat" });
    expect(total).toBe(4);
  }, 60_000);

  it.skipIf(NO_SANDBOX)("where the server runs: a plain child of the starting process, in the same mount, network, user and pid namespaces, so outside any job sandbox of the CLI's own", async () => {
    const pid = child!.pid!;
    const mine = namespaces("self");
    expect(namespaces(pid)).toEqual(mine);
    // The browser it started is in them too, and the mount tables are the same table.
    const browsers = childrenOf(pid);
    expect(browsers.length).toBeGreaterThan(0);
    for (const b of browsers) expect(namespaces(b)).toEqual(mine);
    expect(readFileSync(`/proc/${pid}/mountinfo`, "utf8")).toBe(readFileSync("/proc/self/mountinfo", "utf8"));
    // Its environment is the allowlist it was given: no token, no key.
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    expect(env).not.toMatch(/ANTHROPIC|CLAUDE_CODE|GH_TOKEN|API_KEY/);
    expect(stderr.join("")).toBe("");
  });
});
