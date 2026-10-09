import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { filterDevEnv } from "../src/job/nixShellEnv.js";
import { applyNixView, NIX_DAEMON_SOCKET_DIR } from "../src/sandbox/nixView.js";
import { bwrapArgs } from "../src/sandbox/probe.js";
import { sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";

/**
 * D#6 R7c with real bubblewrap: a job that was handed a Nix dev shell cannot reach the Nix daemon, and the shell's tools run from the environment `cleanEnv`
 * builds out of the filtered variables. The rules come from the one builder (`sandboxSettings`) plus `applyNixView`, are translated by the probe's own
 * translation (`bwrapArgs`), and every claim has a control that shows the thing is really there without the rule. The daemon is the host's real one
 * (a real connect to its real socket); the test skips, naming why, on a machine with no Nix daemon socket.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const SOCKET = path.join(NIX_DAEMON_SOCKET_DIR, "socket");
const usable = ((): boolean => {
  if (BWRAP === undefined || !existsSync(SOCKET)) return false;
  return bwrapCanCreateNamespaces(BWRAP);
})();

let root: string;
let home: string;
let workspace: string;
let tempDir: string;
let withView: Record<string, unknown>;
let withoutView: Record<string, unknown>;
let toolDir: string;

const build = (): Record<string, unknown> =>
  sandboxSettings({ workspace, tempDir, home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(root, "bin"), workspaceRoot: path.dirname(workspace), tempRoot: path.dirname(tempDir) });

function inSandbox(settings: Record<string, unknown>, script: string, env: Record<string, string>): { code: number | null; stdout: string; stderr: string } {
  const args = [...bwrapArgs(settings, (target) => existsSync(target) && statSync(target).isDirectory(), (target) => existsSync(target) && statSync(target).isFile()), "--", "/bin/sh", "-c", script];
  const out = spawnSync(BWRAP!, args, { env, encoding: "utf8", timeout: 20_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

/** A real connect to the daemon's socket, from inside the sandbox, by the node binary of the host. */
const CONNECT = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`const s=require("net").connect(${JSON.stringify(SOCKET)});s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",(e)=>{console.log("ERR "+e.code);process.exit(1)})`)}`;

describe.skipIf(!usable)("R7c: the Nix view in a real bubblewrap sandbox", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join("/tmp", "r7c-bwrap-"));
    home = path.join(root, "home");
    workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
    tempDir = path.join(home, ".cache", "fx-runner", "tmp", "rn-1");
    for (const dir of [workspace, tempDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
    withoutView = build();
    withView = build();
    applyNixView(withView, true);
    // a real tool that lives in the Nix store: the coreutils of this machine
    toolDir = path.dirname(realpathSync(spawnSync("/bin/sh", ["-c", "command -v ls"], { encoding: "utf8" }).stdout.trim()));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const base = (extra: Record<string, string> = {}): Record<string, string> => ({ HOME: home, PATH: "/r7c-nowhere", ...extra });

  it("control: without the Nix view, a process in the sandbox really connects to the daemon's socket and sees it", () => {
    const seen = inSandbox(withoutView, `${CONNECT}; ls ${NIX_DAEMON_SOCKET_DIR}`, base({ PATH: toolDir }));
    expect(seen.stdout).toContain("CONNECTED");
    expect(seen.stdout).toContain("socket");
  });

  it("with the Nix view, the same connect fails and the socket directory is empty", () => {
    const seen = inSandbox(withView, `${CONNECT}; ls -A ${NIX_DAEMON_SOCKET_DIR}`, base({ PATH: toolDir }));
    expect(seen.stdout).not.toContain("CONNECTED");
    expect(seen.stdout).toMatch(/ERR (ENOENT|ECONNREFUSED|EACCES)/);
    expect(seen.stdout).not.toMatch(/^socket$/m);
    expect(inSandbox(withView, `test -S ${SOCKET}`, base()).code).not.toBe(0);
  });

  it("the shell's tools run from the environment cleanEnv builds, and not without it", () => {
    const shell = filterDevEnv({ PATH: { type: "exported", value: `${toolDir}:/usr/bin` }, shellHook: { type: "exported", value: "touch /tmp/r7c-hook-ran" } });
    expect(shell).toEqual({ PATH: toolDir });
    const previous = process.env["PATH"];
    process.env["PATH"] = "/r7c-nowhere";
    let withShell: Record<string, string>;
    let without: Record<string, string>;
    try {
      withShell = cleanEnv({ mode: "subscription" }, { jobEnv: shell });
      without = cleanEnv({ mode: "subscription" });
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
    // control: the same command, with the environment a job without a dev shell has, finds no `ls`
    expect(inSandbox(withView, "ls /", { ...without, HOME: home }).code).not.toBe(0);
    const ran = inSandbox(withView, "ls --version && ls /nix/store > /dev/null && echo TOOLS-RAN", { ...withShell, HOME: home });
    expect(ran.stdout).toContain("TOOLS-RAN");
    expect(withShell["PATH"]!.endsWith(toolDir)).toBe(true);
    expect(withShell["shellHook"]).toBeUndefined();
    expect(existsSync("/tmp/r7c-hook-ran")).toBe(false);
  });

  it("the view adds a read of the store and one hidden directory, and nothing else", () => {
    const fs = (withView["filesystem"] as { allowRead: string[]; denyRead: string[]; allowWrite: string[] });
    const plain = (withoutView["filesystem"] as { allowRead: string[]; denyRead: string[]; allowWrite: string[] });
    expect(fs.allowRead.filter((entry) => !plain.allowRead.includes(entry))).toEqual(["/nix/store"]);
    expect(fs.denyRead.filter((entry) => !plain.denyRead.includes(entry))).toEqual([NIX_DAEMON_SOCKET_DIR]);
    expect(fs.allowWrite).toEqual(plain.allowWrite);
    // the daemon directory is hidden for a job that was given no shell too
    const hiddenOnly = build();
    applyNixView(hiddenOnly, false);
    expect((hiddenOnly["filesystem"] as { denyRead: string[]; allowRead: string[] }).denyRead).toContain(NIX_DAEMON_SOCKET_DIR);
    expect((hiddenOnly["filesystem"] as { allowRead: string[] }).allowRead).not.toContain("/nix/store");
  });
});
