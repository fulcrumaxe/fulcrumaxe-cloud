import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_PORT, CHANNEL_SOCKET, SESSION_READY_LINE, type ChannelReply } from "../../src/engineHost/guestSession.js";
import { unixSocketsRefused } from "../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { tempDir } from "../helpers/tempTree.js";

/**
 * D#845 ON-13b1: the guest's two new files, checked on any machine with python3 and node: `engine-bridge.py` (listening on a unix socket instead of vsock with `--unix`, as agent.py does) carries bytes to the supervisor's socket
 * and ends with it; and the real bundle of `engine-supervisor.entry.mjs`, built by esbuild exactly as `vm-main.mjs` builds it, answers the channel with a stand-in for the CLI. The vsock transport itself and the host-only peer check are the real-VM test's.
 */
const GUEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "infra", "microvm-image", "guest");
const python = spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"]).status === 0;
const skip = !python || unixSocketsRefused();
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
});

const frame = (o: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(o));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
};
const ask = (file: string, o: unknown): Promise<ChannelReply> =>
  new Promise((resolve, reject) => {
    const c = net.connect(file);
    const got: Buffer[] = [];
    c.on("error", reject);
    c.on("data", (d) => got.push(d));
    c.on("close", () => {
      const all = Buffer.concat(got);
      resolve(JSON.parse(all.subarray(4, 4 + all.readUInt32BE(0)).toString("utf8")) as ChannelReply);
    });
    c.write(frame(o));
  });
const until = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("the guest files of the engine session", () => {
  it("the bridge parses, serves the one port the host connects to, and answers only the host", () => {
    expect(spawnSync("python3", ["-I", "-m", "py_compile", path.join(GUEST_DIR, "engine-bridge.py")]).status).toBe(0);
    const source = readFileSync(path.join(GUEST_DIR, "engine-bridge.py"), "utf8");
    expect(source).toContain(`PORT = ${CHANNEL_PORT}`);
    expect(source).toContain("HOST_CID = 2");
    expect(source).toContain(CHANNEL_SOCKET);
    // it opens no network socket and reads no frame of the channel
    expect(source).not.toMatch(/AF_INET|json/);
  });
});

describe.skipIf(skip)("engine-bridge.py", () => {
  /** A supervisor stand-in: listens on FX_ENGINE_SOCK and answers each connection with `echo:` and what it read. */
  const STANDIN = `const net = require("net"); net.createServer((s) => { s.on("data", (d) => s.end(Buffer.concat([Buffer.from("echo:"), d]))); }).listen(process.env.FX_ENGINE_SOCK); `;
  function start(exitAfterMs?: number): { sock: string; child: ChildProcess; dir: string } {
    const dir = tempDir("fxb-", socketTmpRoot());
    const entry = path.join(dir, "standin.js");
    writeFileSync(entry, exitAfterMs === undefined ? STANDIN : `${STANDIN}setTimeout(() => process.exit(0), ${exitAfterMs});\n`);
    const sock = path.join(dir, "bridge.sock");
    const sockDir = path.join(dir, "run");
    mkdirSync(sockDir, { mode: 0o700 });
    const child = spawn("python3", ["-I", path.join(GUEST_DIR, "engine-bridge.py"), "--unix", sock], {
      env: { PATH: path.dirname(spawnSync("which", ["python3"]).stdout.toString().trim()), FX_ENGINE_NODE: process.execPath, FX_ENGINE_ENTRY: entry, FX_ENGINE_SOCK_DIR: sockDir, FX_ENGINE_DIR: path.join(dir, "state"), FX_ENGINE_UID: String(process.getuid?.() ?? 0) },
      stdio: "ignore",
    });
    kids.push(child);
    return { sock, child, dir };
  }

  it("carries a connection's bytes to the supervisor's socket and its answer back, one connection at a time or several", async () => {
    const { sock, dir } = start();
    await until(() => existsSync(sock) && existsSync(path.join(dir, "run", "channel.sock")), "the bridge and the stand-in to listen");
    const one = (text: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const c = net.connect(sock);
        let got = "";
        c.on("error", reject);
        c.on("data", (d) => (got += d.toString()));
        c.on("close", () => resolve(got));
        c.write(text);
      });
    expect(await one("hello")).toBe("echo:hello");
    expect(await Promise.all([one("a"), one("b"), one("c")])).toEqual(["echo:a", "echo:b", "echo:c"]);
  });

  it("ends, with a failing status, when the supervisor ends, so the guest's init loop starts both again", async () => {
    const { child } = start(300);
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    expect(code).toBe(1);
  });
});

describe.skipIf(skip)("the bundled fx-engine-supervisor", () => {
  it("bundles from the guest entry with esbuild, runs under node, says ready, and serves tick, usage_tick and stop with a stand-in CLI", async () => {
    const scratch = tempDir("fxe-", socketTmpRoot());
    const bundle = path.join(scratch, "fx-engine-supervisor.mjs");
    const built = await build({ entryPoints: [path.join(GUEST_DIR, "engine-supervisor.entry.mjs")], bundle: true, platform: "node", format: "esm", target: "node24", write: false, legalComments: "none", logLevel: "silent" });
    writeFileSync(bundle, built.outputFiles[0]?.text ?? "");
    const text = readFileSync(bundle, "utf8");
    expect(text).toContain("fx-engine-session-ready");
    // the supervisor's own refusal of permission-skipping flags is in the bundle, and so is no systemd launch for the guest to trip over
    expect(text).toContain("refusing a host argument vector with extra flags");
    const claude = path.join(scratch, "host-standin");
    writeFileSync(claude, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"e6a767e1-7e3f-44a4-bfb1-3c331803d4ee"})+"\\n");process.stdin.on("data",()=>process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4},modelUsage:{"claude-haiku-4-5":{}}})+"\\n"));process.stdin.on("end",()=>process.exit(0));\n`, { mode: 0o755 });
    const checkout = path.join(scratch, "checkout");
    mkdirSync(checkout);
    const dir = path.join(scratch, "state");
    const sock = path.join(scratch, "s.sock");
    const child = spawn(process.execPath, [bundle], { env: { FX_ENGINE_DIR: dir, FX_ENGINE_SOCK: sock, FX_ENGINE_CLAUDE: claude }, stdio: ["ignore", "pipe", "ignore"] });
    kids.push(child);
    let said = "";
    child.stdout?.on("data", (d: Buffer) => (said += d.toString()));
    await until(() => said.includes(SESSION_READY_LINE), "the ready line");
    writeFileSync(path.join(dir, "session.json"), JSON.stringify({ repo_gh_id: "424242", repo_checkout: checkout }), { mode: 0o600 });
    expect(await ask(sock, { op: "tick", text: "go" })).toEqual({ ok: true, started: true });
    let lines: string[] = [];
    await until(() => {
      void ask(sock, { op: "events_read", after: 0 }).then((r) => (lines = (r as unknown as { lines: string[] }).lines));
      return lines.some((l) => l.includes('"usage_tick"'));
    }, "the usage_tick");
    expect(JSON.parse(lines.find((l) => l.includes('"usage_tick"')) as string)).toMatchObject({ model_tier: "claude-haiku-4-5", input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 });
    expect(await ask(sock, { op: "stop" })).toMatchObject({ ok: true, survivors: 0, token_wiped: true });
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("exit", resolve));
  }, 30_000);
});
