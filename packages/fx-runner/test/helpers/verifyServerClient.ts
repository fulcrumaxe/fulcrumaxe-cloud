import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DEPLOY_VERIFIER_ROLE } from "@fulcrumaxe/runner-protocol";
import { mcpConfigFor } from "../../src/engines/claude/settingsFile.js";
import { findChromium } from "../../src/verifyBrowser/driver.js";
import { tmpRoot } from "./tmpRoot.js";

/**
 * D#749 V2c-2c: starts a REAL fx-runner program (the single executable a release builds) as the `fxverify` MCP server of a playwright deploy job, exactly as the job's MCP file spells it, against
 * a page on loopback and a real Chromium, and lets a test ask it to open the page. Whether the program found its Playwright library shows in the answer: `opened`, or the closed code
 * `playwright_missing`. Returns undefined when no Chromium is installed (the caller skips, naming the reason).
 */
export const CHROMIUM = findChromium(process.env);

export interface VerifyServerRun {
  /** What the first page open answered, and whether it was an error. */
  open(): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

type Reply = { result?: { content?: Array<{ text: string }>; isError?: boolean } };

export async function startVerifyServer(binary: string, extraEnv: Record<string, string> = {}): Promise<VerifyServerRun> {
  if (CHROMIUM === undefined) throw new Error("no Chromium installed");
  const work = mkdtempSync(path.join(tmpRoot(), "pw-real-"));
  const jobDir = path.join(work, "job");
  mkdirSync(jobDir, { mode: 0o700 });
  const app: Server = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><meta charset=utf-8><h1>Orders</h1><p>Total: 3</p>"));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const state = path.join(work, "storage-state.json");
  writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "test-account", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }), { mode: 0o600 });
  chmodSync(state, 0o600);
  const entry = mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" }, jobDir, { command: binary, args: [], baseUrl: base, executable: CHROMIUM, storageState: state }).mcpServers["fxverify"] as { command: string; args: string[]; env: Record<string, string> };
  // The engine's kind of environment: a short allowlist and no token. NODE_PATH is deliberately NOT set: the program must find its library by itself.
  const child = spawn(entry.command, entry.args, { env: { ...entry.env, PATH: process.env.PATH ?? "", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffer = "";
  let nextId = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const reply = JSON.parse(line) as { id: number };
        waiting.get(reply.id)?.(reply as Reply);
      } catch {
        // a line that is not a reply is not ours to answer
      }
    }
  });
  const rpc = (method: string, params?: unknown): Promise<Reply> =>
    new Promise((resolve) => {
      nextId += 1;
      waiting.set(nextId, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params })}\n`);
    });
  const call = async (name: string, args?: unknown): Promise<{ text: string; isError: boolean }> => {
    const reply = await rpc("tools/call", { name, arguments: args });
    return { text: reply.result?.content?.[0]?.text ?? "", isError: reply.result?.isError === true };
  };
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  return {
    open: async () => {
      await call("begin_journey", { id: "orders" });
      return call("open", { path: "/" });
    },
    close: async () => {
      child.stdin.end();
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.kill("SIGKILL");
      app.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}
