import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeBrowser, type BrowserProbeDeps, type ProcessInfo } from "../../src/daemon/browserProbe.js";
import { itUnixSockets } from "../helpers/needsHostSockets.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";

/**
 * A unix socket's path holds at most 107 bytes. The gate runs these suites with a deeply nested TMPDIR, where a fixture built under it cannot be listened on (EINVAL). These tests
 * run with a deliberately long TMPDIR and show that the fixtures stay short, and what the product probe answers when the user's own temp directory is that long.
 */
const USER = "tester";
const CHROME: ProcessInfo = { pid: 100, comm: "chrome", args: "chrome" };
const HOST: ProcessInfo = { pid: 4242, comm: "claude", args: "claude --chrome-native-host" };
const made: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function longTmpdir(): string {
  const parent = mkdtempSync("/tmp/fxr-long-");
  made.push(parent);
  const long = path.join(parent, "a".repeat(40), "b".repeat(40));
  mkdirSync(long, { recursive: true });
  expect(long.length).toBeGreaterThan(80);
  return long;
}

const deps = (tmpRoot: string): BrowserProbeDeps => ({ testAccount: () => "fx-test-user", uid: process.getuid?.() ?? 0, username: USER, platform: "linux", tmpRoot, processes: async () => [CHROME, HOST] });

const listenAt = (server: net.Server, file: string): Promise<void> => new Promise<void>((resolve, reject) => server.once("error", reject).listen(file, resolve));

describe("socket fixtures under a long TMPDIR", () => {
  itUnixSockets("the fixture base falls back to a short path, and a healthy probe case passes there", async () => {
    vi.stubEnv("TMPDIR", longTmpdir());
    const base = socketTmpRoot();
    expect(base.length).toBeLessThanOrEqual(30);
    const root = mkdtempSync(path.join(base, "probe-"));
    made.push(root);
    const bridge = path.join(root, `claude-mcp-browser-bridge-${USER}`);
    mkdirSync(bridge, { mode: 0o700 });
    const server = net.createServer();
    servers.push(server);
    await listenAt(server, path.join(bridge, "4242.sock"));
    expect(await probeBrowser(deps(root))).toEqual({ ok: true });
  });

  it("the product probe with a user temp directory too long for any socket answers bridge_not_connected, and does not throw", async () => {
    const long = longTmpdir();
    const bridge = path.join(long, `claude-mcp-browser-bridge-${USER}`);
    mkdirSync(bridge, { mode: 0o700 });
    expect(path.join(bridge, "4242.sock").length).toBeGreaterThan(107);
    // The socket is genuinely absent: nothing is listened on, so the probe reads an empty bridge directory.
    expect(await probeBrowser(deps(long))).toEqual({ ok: false, reason: "bridge_not_connected" });
  });
});
