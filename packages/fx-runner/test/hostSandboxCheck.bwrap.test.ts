import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentHandle } from "@fulcrumaxe/runner-protocol";
import { cleanEnv } from "../src/job/cleanEnv.js";
import { createHostSandbox, type InterruptibleRuntime } from "../src/sandbox/hostSandbox.js";
import type { SandboxHandle } from "../src/sandbox/port.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * D#6 R-CHK-2 with real bubblewrap: the check is started under the very settings the agent's sandbox was built with, with the dev shell's variables only when asked, and
 * with no model credential, no env file and no network. The agent itself is a stub that ends at once; the rules are the host sandbox's own.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);
const CANARY = "FX-RCHK2-CANARY";
const USER_RUNTIME = ["", "run", "user"].join("/");

let root: string;
let home: string;
let workspace: string;
let handle: SandboxHandle;
let host: ReturnType<typeof createHostSandbox>;
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

function launchOf(argv: string[], devShell: boolean) {
  const launch = host.checkLaunch(handle, argv, devShell);
  if (launch === undefined || "refused" in launch) throw new Error("no launch");
  return launch;
}

/** Runs `script` under the check's launch; `filter: false` leaves the seccomp filter out, as a control that it is what stops a thing. */
function sh(script: string, devShell: boolean, filter = true) {
  const launch = launchOf(["sh", "-c", script], devShell);
  const fed = filter ? launch.feed : undefined;
  const args = filter ? launch.args : launch.args.slice(2);
  const file = path.join(root, `filter-${Math.random().toString(36).slice(2)}`);
  if (fed !== undefined) writeFileSync(file, fed);
  const fd = fed === undefined ? undefined : openSync(file, "r");
  const out = spawnSync(launch.tool, args, { env: launch.env, cwd: workspace, encoding: "utf8", timeout: 20_000, stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", fd] });
  if (fd !== undefined) closeSync(fd);
  return { code: out.status, stdout: out.stdout, stderr: out.stderr, env: launch.env };
}

describe.skipIf(!usable)("R-CHK-2: the check under the job's own sandbox rules", () => {
  beforeAll(async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token-value-for-the-agent";
    root = mkdtempSync(path.join(tmpRoot(), "rchk2-bwrap-"));
    home = path.join(root, "home");
    workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
    const tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
    const stateDir = path.join(home, ".fx-runner");
    for (const dir of [workspace, tempRoot, stateDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(home, "notes.txt"), CANARY);
    const runtime: InterruptibleRuntime = {
      start: async () => ({ handle: { runId: "r1", done: Promise.resolve({ status: "done" }) } as unknown as AgentHandle }),
      stop: async () => undefined,
    } as unknown as InterruptibleRuntime;
    host = createHostSandbox({ credentials: { mode: "subscription" }, makeRuntime: () => runtime, home, stateDir, binaryDir: path.join(root, "bin"), tempRoot, workspaceRoot: path.dirname(workspace), packageStoreRoot: path.join(home, ".cache", "fx-runner", "pnpm-store") });
    handle = await host.createSandbox({ sandboxName: "rn-r1", retention: { persistent: false }, timeoutMs: 600_000 });
    const started = host.startDetached(handle, { runId: "r1", role: "executor", roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: workspace, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined } as never);
    await started.hookFired.catch(() => undefined);
    // a second start with allowances and a dev shell, so the dev shell variables exist to be asked for
    await host.deleteSandbox(handle);
    handle = await host.createSandbox({ sandboxName: "rn-r2", retention: { persistent: false }, timeoutMs: 600_000 });
    const grant = { entries: [{ kind: "domain" as const, value: "registry.npmjs.org", access: "connect" as const, reason: "install" }], commandTimeoutS: 600, storeKey: "acme__widgets", nixEnv: { PATH: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-node/bin" } };
    const second = host.startDetached(handle, { runId: "r2", role: "executor", roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: workspace, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), allowances: grant, onEvent: () => undefined } as never);
    await second.hookFired.catch(() => undefined);
  });
  afterAll(() => {
    if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    rmSync(root, { recursive: true, force: true });
  });

  it("control: it runs in the workspace, which it can write, and the job's temp directory is its TMPDIR", () => {
    const out = sh(`pwd && echo ok > w.txt && cat w.txt && test -w "$TMPDIR" && echo tmp-ok`, false);
    expect(out.stdout).toContain(workspace);
    expect(out.stdout).toContain("ok\n");
    expect(out.stdout).toContain("tmp-ok");
  });

  it("the home directory's files are unreadable, as for the agent", () => {
    const out = sh(`cat ${path.join(home, "notes.txt")}`, false);
    expect(out.code).not.toBe(0);
    expect(out.stdout).not.toContain(CANARY);
  });

  it("holds no model credential and no env file name, whatever the runner's own environment has", () => {
    const out = sh("env", false);
    expect(out.stdout).not.toContain("oauth-token-value-for-the-agent");
    expect(out.stdout).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(out.stdout).not.toContain("CLAUDE_ENV_FILE");
    expect(out.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(out.env.CLAUDE_ENV_FILE).toBeUndefined();
  });

  it("has no network: a listener on the host's loopback cannot be reached from the check, and can from here", async () => {
    const server = createServer((socket) => socket.end("hi"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const probe = `exec 3<>/dev/tcp/127.0.0.1/${port} && echo connected`;
      expect(spawnSync("bash", ["-c", probe], { encoding: "utf8" }).stdout).toContain("connected");
      const out = sh(`bash -c '${probe}'`, false);
      expect(out.stdout).not.toContain("connected");
    } finally {
      server.close();
    }
  });

  it("the dev shell's variables are present only when the check asks for the dev shell", () => {
    expect(sh("echo $PATH", true).stdout).toContain("/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-node/bin");
    expect(sh("echo $PATH", false).stdout).not.toContain("/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-node/bin");
  });

  it("cannot open a Unix-domain socket (the user bus, a container runtime and a display server are reached that way), though the same program can from here and without the filter", async () => {
    const sock = path.join(root, "outside.sock");
    const server = createServer((socket) => socket.end("hi"));
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const program = `const s=require("net").connect(${JSON.stringify(sock)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",(e)=>{console.log("error "+e.code);process.exit(1)})`;
      const command = `${JSON.stringify(process.execPath)} -e '${program}'`;
      expect(spawnSync(process.execPath, ["-e", program], { encoding: "utf8", timeout: 10_000 }).stdout).toContain("connected");
      expect(sh(command, false, false).stdout).toContain("connected");
      const filtered = sh(command, false);
      expect(filtered.stdout).not.toContain("connected");
      expect(filtered.stdout).toMatch(/error (EPERM|EACCES)/);
    } finally {
      server.close();
    }
  });

  it("can still use loopback internet sockets inside its own network namespace", () => {
    const program = `require("net").createServer().listen(0,"127.0.0.1",function(){console.log("listening");process.exit(0)}).on("error",function(e){console.log("error "+e.code);process.exit(1)})`;
    expect(sh(`${JSON.stringify(process.execPath)} -e '${program}'`, false).stdout).toContain("listening");
  });

  it("cannot write the files the agent's sandbox protects or the version-control folder: lock files, .env files, shell start-up files and the folder itself are read-only", () => {
    const vcs = path.join(workspace, ".git");
    mkdirSync(vcs, { recursive: true });
    writeFileSync(path.join(vcs, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(path.join(workspace, ".env.local"), "A=1\n");
    writeFileSync(path.join(workspace, ".bashrc"), "# mine\n");
    const out = sh("echo x >> pnpm-lock.yaml; echo $? ; echo x >> .env.local; echo $?; echo x >> .bashrc; echo $?; echo x >> .git/HEAD; echo $?; echo y > .git/new; echo $?; echo ok > ordinary.txt; echo $?", false);
    expect(out.stdout.split("\n").filter((line) => /^\d+$/.test(line))).toEqual(["1", "1", "1", "1", "1", "0"]);
    expect(readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8")).toBe("lockfileVersion: 9\n");
    expect(readFileSync(path.join(vcs, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(existsSync(path.join(vcs, "new"))).toBe(false);
  });

  it("does not see the user's runtime directory with its session bus", () => {
    expect(sh(`ls ${USER_RUNTIME} 2>&1 | wc -l`, false).stdout.trim()).toBe("0");
  });

  it("is refused on a platform whose sandbox is not the agent's, in words a summary can carry, and nothing is launched", async () => {
    const other = createHostSandbox({ credentials: { mode: "subscription" }, makeRuntime: () => ({ start: async () => ({ handle: { runId: "r3", done: Promise.resolve({ status: "done" }) } }), stop: async () => undefined }) as unknown as InterruptibleRuntime, home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(root, "bin"), tempRoot: path.join(home, ".cache", "fx-runner", "tmp"), workspaceRoot: path.dirname(workspace), platform: "darwin" });
    const target = await other.createSandbox({ sandboxName: "rn-r3", retention: { persistent: false }, timeoutMs: 600_000 });
    await other.startDetached(target, { runId: "r3", role: "executor", roleCard: "x", prompt: "p", model: "sonnet", capUsd: 0, workdir: workspace, networkPolicy: [], env: cleanEnv({ mode: "subscription" }), onEvent: () => undefined } as never).hookFired.catch(() => undefined);
    const launch = other.checkLaunch(target, ["true"], false);
    expect(launch).toEqual({ refused: expect.stringContaining("not available on this platform") });
  });

  it("nothing is started for a sandbox that is gone, or an empty vector", async () => {
    expect(host.checkLaunch(handle, [], false)).toBeUndefined();
    await host.deleteSandbox(handle);
    expect(host.checkLaunch(handle, ["true"], false)).toBeUndefined();
  });
});
