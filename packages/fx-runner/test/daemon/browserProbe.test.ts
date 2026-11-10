import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHROME_NOT_CONNECTED, probeBrowser, psProcesses, type BrowserProbeDeps, type ProcessInfo } from "../../src/daemon/browserProbe.js";
import type { InstallCapture } from "../../src/daemon/engineKit.js";
import { runInstall } from "../../src/engines/claude/capture.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";

/**
 * D#749 V2b: the daemon's own check that the machine can serve a browser job. The bridge directory is a real directory in a temporary tree with a real unix socket in it (made by
 * a listening server, so it is a socket and not a file named like one), and each test breaks one fact the real checks look at: the owner, the mode, a link, the socket type, a
 * stale process. The process list is a port; the real `ps` adapter is run against the real process table below.
 */
const UID = process.getuid?.() ?? 0;
const USER = "tester";
const BRIDGE = `claude-mcp-browser-bridge-${USER}`;
const CHROME: ProcessInfo = { pid: 100, comm: "chrome", args: "/opt/chrome/chrome --type=zygote" };
const HOST: ProcessInfo = { pid: 4242, comm: "claude", args: "/home/x/.local/bin/claude --chrome-native-host" };

let base: string;
let tmp: string;
const servers: net.Server[] = [];

async function socketAt(file: string): Promise<void> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(file, resolve));
}

/** A machine where everything holds: a private bridge directory with the native host's socket in it. */
async function healthy(): Promise<void> {
  mkdirSync(path.join(tmp, BRIDGE), { mode: 0o700 });
  await socketAt(path.join(tmp, BRIDGE, "4242.sock"));
}

const deps = (list: readonly ProcessInfo[] | undefined = [CHROME, HOST], over: Partial<BrowserProbeDeps> = {}): BrowserProbeDeps => ({ testAccount: () => "fx-test-user", uid: UID, username: USER, platform: "linux", tmpRoot: tmp, processes: async () => list, ...over });

beforeAll(() => {
  base = mkdtempSync(path.join(socketTmpRoot(), "probe-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  tmp = path.join(mkdtempSync(path.join(base, "case-")), "t");
  mkdirSync(tmp);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("browser probe", () => {
  it("passes when Chrome runs and its native host has a live socket in the user's private bridge directory", async () => {
    await healthy();
    expect(await probeBrowser(deps())).toEqual({ ok: true });
  });

  it("says the one sentence for every failure", () => {
    expect(CHROME_NOT_CONNECTED).toBe("chrome not connected");
  });

  it("needs a test account: none configured, or an empty label, is not_configured whatever else holds", async () => {
    await healthy();
    expect(await probeBrowser(deps(undefined, { testAccount: () => undefined }))).toEqual({ ok: false, reason: "not_configured" });
    expect(await probeBrowser(deps(undefined, { testAccount: () => "" }))).toEqual({ ok: false, reason: "not_configured" });
  });

  it("is Linux only: any other platform is unsupported, never a guess", async () => {
    await healthy();
    for (const platform of ["darwin", "win32", "freebsd"] as const) expect(await probeBrowser(deps(undefined, { platform }))).toEqual({ ok: false, reason: "unsupported_platform" });
  });

  it("a process list that could not be read fails closed", async () => {
    await healthy();
    expect(await probeBrowser(deps(undefined, { processes: async () => undefined }))).toEqual({ ok: false, reason: "processes_unreadable" });
  });

  it("no Chrome process is chrome_not_running, even with a socket in place; look-alike names do not count", async () => {
    await healthy();
    expect(await probeBrowser(deps([HOST]))).toEqual({ ok: false, reason: "chrome_not_running" });
    for (const comm of ["firefox", "chromedriver", "chrome-sandbox", "notchrome"]) expect(await probeBrowser(deps([{ ...CHROME, comm }, HOST])), comm).toEqual({ ok: false, reason: "chrome_not_running" });
  });

  it("recognises the names Chrome and Chromium run under, with a wrapper's leading dot", async () => {
    await healthy();
    for (const comm of ["chromium", "google-chrome-s", ".chrome-wrapped", "chromium-browse"]) expect(await probeBrowser(deps([{ ...CHROME, comm }, HOST])), comm).toEqual({ ok: true });
  });

  it("no bridge directory is bridge_not_connected", async () => {
    expect(await probeBrowser(deps())).toEqual({ ok: false, reason: "bridge_not_connected" });
  });

  it("a bridge directory open to others, one of another user, or a link to a good one, is not the user's bridge", async () => {
    await healthy();
    chmodSync(path.join(tmp, BRIDGE), 0o750);
    expect(await probeBrowser(deps())).toEqual({ ok: false, reason: "bridge_not_connected" });
    chmodSync(path.join(tmp, BRIDGE), 0o700);
    expect(await probeBrowser(deps())).toEqual({ ok: true });
    expect(await probeBrowser(deps(undefined, { uid: UID + 1 }))).toEqual({ ok: false, reason: "bridge_not_connected" });
    symlinkSync(path.join(tmp, BRIDGE), path.join(tmp, "claude-mcp-browser-bridge-linked"));
    expect(await probeBrowser(deps(undefined, { username: "linked" }))).toEqual({ ok: false, reason: "bridge_not_connected" });
  });

  // A real file of another user cannot be made without root, so the owner of ONE path is changed at the lstat port; the rest is the real tree. Each ownership check is then tested alone.
  const ownedBy = (target: (p: string) => boolean, uid: number) => (p: string) => {
    const stat = lstatSync(p, { throwIfNoEntry: false });
    return stat === undefined ? null : target(p) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid }) : stat;
  };

  it("a bridge directory of another user is refused even when the socket and the process are right", async () => {
    await healthy();
    expect(await probeBrowser(deps(undefined, { lstat: ownedBy((p) => p.endsWith(BRIDGE), UID + 1) }))).toEqual({ ok: false, reason: "bridge_not_connected" });
    expect(await probeBrowser(deps(undefined, { lstat: ownedBy(() => false, UID + 1) }))).toEqual({ ok: true });
  });

  it("a socket of another user is refused even when the directory is the user's own", async () => {
    await healthy();
    expect(await probeBrowser(deps(undefined, { lstat: ownedBy((p) => p.endsWith(".sock"), UID + 1) }))).toEqual({ ok: false, reason: "bridge_not_connected" });
  });

  it("with a different uid asked for, directory and socket both fail closed", async () => {
    await healthy();
    expect(await probeBrowser(deps(undefined, { uid: UID + 1 }))).toEqual({ ok: false, reason: "bridge_not_connected" });
  });

  it("a name that is not a socket is refused: a plain file, a symlink to the real socket, a name that is not <pid>.sock", async () => {
    mkdirSync(path.join(tmp, BRIDGE), { mode: 0o700 });
    writeFileSync(path.join(tmp, BRIDGE, "4242.sock"), "not a socket");
    expect(await probeBrowser(deps())).toEqual({ ok: false, reason: "bridge_not_connected" });
    rmSync(path.join(tmp, BRIDGE, "4242.sock"));
    await socketAt(path.join(tmp, "real.sock"));
    symlinkSync(path.join(tmp, "real.sock"), path.join(tmp, BRIDGE, "4242.sock"));
    expect(await probeBrowser(deps())).toEqual({ ok: false, reason: "bridge_not_connected" });
    rmSync(path.join(tmp, BRIDGE, "4242.sock"));
    await socketAt(path.join(tmp, BRIDGE, "native.sock"));
    expect(await probeBrowser(deps())).toEqual({ ok: false, reason: "bridge_not_connected" });
  });

  it("a stale socket is refused: its process is gone, is not a native host, or only has a longer flag", async () => {
    mkdirSync(path.join(tmp, BRIDGE), { mode: 0o700 });
    await socketAt(path.join(tmp, BRIDGE, "4242.sock"));
    expect(await probeBrowser(deps([CHROME]))).toEqual({ ok: false, reason: "bridge_not_connected" });
    expect(await probeBrowser(deps([CHROME, { ...HOST, args: "claude -p" }]))).toEqual({ ok: false, reason: "bridge_not_connected" });
    expect(await probeBrowser(deps([CHROME, { ...HOST, args: "claude --chrome-native-host-extra" }]))).toEqual({ ok: false, reason: "bridge_not_connected" });
    expect(await probeBrowser(deps([CHROME, { ...HOST, pid: 4243 }]))).toEqual({ ok: false, reason: "bridge_not_connected" });
    expect(await probeBrowser(deps([CHROME, HOST]))).toEqual({ ok: true });
  });

  it("a user name that could name another place is refused, not joined into a path", async () => {
    await healthy();
    for (const username of ["", "..", "a/b", "x y", "a".repeat(65)]) expect(await probeBrowser(deps(undefined, { username })), username).toEqual({ ok: false, reason: "bridge_not_connected" });
  });

  it("the signed-in account is checked when a reader for it exists: a different label is wrong_account, an unreadable one account_unreadable", async () => {
    await healthy();
    expect(await probeBrowser(deps(undefined, { accountLabel: () => "fx-test-user" }))).toEqual({ ok: true });
    expect(await probeBrowser(deps(undefined, { accountLabel: () => "someone-else" }))).toEqual({ ok: false, reason: "wrong_account" });
    expect(await probeBrowser(deps(undefined, { accountLabel: () => undefined }))).toEqual({ ok: false, reason: "account_unreadable" });
  });

  it("with no reader the account is not claimed to be checked: the probe passes on the facts it can read", async () => {
    await healthy();
    expect(await probeBrowser(deps(undefined, { accountLabel: undefined }))).toEqual({ ok: true });
  });
});

describe("the real process list (ps, through the engine's own capture)", () => {
  const capture: InstallCapture = (command, args, env, cwd, timeoutMs, tailChars, signal, feed, onLine) => runInstall(spawn, command, args, env, cwd, timeoutMs, tailChars, signal, feed, onLine);

  it("lists this user's processes with pid, name and command line: the test process itself is in it", async () => {
    const list = await psProcesses(capture, UID, process.env["PATH"]);
    const me = list?.find((p) => p.pid === process.pid);
    expect(me).toBeDefined();
    expect(me!.comm.length).toBeGreaterThan(0);
    expect(me!.args).toContain("node");
  });

  it("a listing that fails is undefined, so the probe fails closed", async () => {
    expect(await psProcesses(capture, UID, "/nonexistent-dir")).toBeUndefined();
    expect(await psProcesses(async () => ({ code: 1, tail: "x", timedOut: false, aborted: false }), UID, undefined)).toBeUndefined();
    expect(await psProcesses(async () => ({ code: 0, tail: "garbage without numbers", timedOut: false, aborted: false }), UID, undefined)).toBeUndefined();
  });
});
