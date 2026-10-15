import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Io } from "../src/context.js";
import { main } from "../src/main.js";
import { generateToken } from "../../api/src/tokens/format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_DIR = path.join(here, "..");
const fixtures = path.join(here, "..", "..", "api", "fixtures", "v1");
export const fixture = (id: string, file: string): string => readFileSync(path.join(fixtures, id, file), "utf8");
export const err = (code: string, message = "m"): string => JSON.stringify({ error: { code, message, request_id: "r-1" } });
export const newToken = (): string => generateToken();

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  at: number;
}
export interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** A real loopback `node:http` server read by Node's real global fetch: no fetch double anywhere in this package's tests. */
export class FixtureServer {
  seen: Seen[] = [];
  reply: (req: Seen) => Reply = () => ({ status: 500 });
  private server: Server = createServer((req, res) => {
    const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, at: Date.now() };
    this.seen.push(s);
    const r = this.reply(s);
    res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
    res.end(r.body ?? "");
  });
  origin = "";
  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export const tempHome = (): string => mkdtempSync(path.join(tmpdir(), "fxcli-"));

export interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  /** Really wait out a 429's Retry-After (the default skips the wait). */
  realSleep?: boolean;
}
export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in this process against the real network stack. `home` is a temp dir, so nothing touches the real config. */
export async function run(home: string, argv: string[], o: RunOptions = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough();
  stdin.end(o.stdin ?? "");
  const io: Io = {
    env: { ...o.env },
    stdout: { write: (c) => ((stdout += c), true) },
    stderr: { write: (c) => ((stderr += c), true) },
    stdin,
    platform: o.platform ?? "linux",
    uid: o.uid ?? process.getuid?.(),
    home,
    ...(o.realSleep ? {} : { sleep: async () => {} }),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

/** Runs the real entry point as a child process (through tsx, as the source tree does). `argvLog` receives every argument it was given. */
export function spawnCli(home: string, argv: string[], o: RunOptions & { argvLog?: string[][] } = {}): Promise<Result> {
  o.argvLog?.push(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(CLI_DIR, "bin", "fulcrumaxe.mjs"), ...argv], {
      cwd: CLI_DIR,
      env: { PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...o.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(o.stdin ?? "");
  });
}
