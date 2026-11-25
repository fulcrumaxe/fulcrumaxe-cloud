import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SURVEY_ROLE } from "@fulcrumaxe/runner-protocol";
import { protectedPaths, sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { settingsFor } from "../src/engines/claude/settingsFile.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";
import { findOnPath } from "./helpers/findOnPath.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * D#845 ON-10c: the hostile fake agent on the OS-sandbox tier, over the REAL sandbox block the runner builds for the survey and a REAL bubblewrap.
 *
 * The fake agent is a small program run in place of the CLI. It does what a prompt-injected surveyor would try: write a file into the working copy, change a file in it, write into its `.git`, write outside its own
 * temp directory (a neighbouring directory, and the machine's /tmp), write through a link that points into the working copy, and open `github.com:443` and an address on this machine. Every attempt must be refused, and
 * the one write that is allowed (its own temp directory, the run's TMPDIR) must work, so that the refusals are not just a broken sandbox.
 *
 * How the block becomes a sandbox: the CLI turns the block's `filesystem` into a bubblewrap shell sandbox; the runner's model of that translation is the whole file system read-only, each `allowWrite` path writable, each
 * `denyWrite` path read-only again (`bashSandboxArgs` is the same model for `Edit` denies). The CLI itself is not run in tests. What this cannot show: the CLI's own network allowlist (its proxy decides which hosts a shell may
 * reach); here the agent has NO network namespace at all, so the refusals shown are the floor beneath it, and the block's allowlist is pinned to the model host in `hostSandbox.test.ts`.
 *
 * PATH: the fake agent runs with a private PATH that holds only the fake itself. The test asserts that the real `claude`, `gh` and any `git-credential-*` helper are unreachable on it before the agent starts.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);

const HOSTILE = `
import { appendFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
const [ws, own, outside, port] = process.argv.slice(2);
const tries = {};
const attempt = (name, fn) => { try { fn(); tries[name] = "written"; } catch (error) { tries[name] = error.code ?? "error"; } };
attempt("new file in the working copy", () => writeFileSync(path.join(ws, "hostile.txt"), "x"));
attempt("change a file in the working copy", () => appendFileSync(path.join(ws, "README.md"), "x"));
attempt("make a directory in the working copy", () => mkdirSync(path.join(ws, "newdir")));
attempt("write into the working copy's .git", () => writeFileSync(path.join(ws, ".git", "hooks", "pre-commit"), "x"));
attempt("change the working copy's .git config", () => appendFileSync(path.join(ws, ".git", "config"), "[core]\\n"));
attempt("write in a neighbouring directory", () => writeFileSync(path.join(outside, "neighbour.txt"), "x"));
attempt("write in the machine's /tmp", () => writeFileSync("/tmp/fx-survey-hostile-" + process.pid, "x"));
attempt("write a file named like the run's own directory, outside it", () => writeFileSync(own + "-sibling", "x"));
attempt("write through a link in the temp directory that points into the working copy", () => { symlinkSync(ws, path.join(own, "link")); writeFileSync(path.join(own, "link", "through.txt"), "x"); });
attempt("write its own answer in its temp directory (the one allowed write)", () => writeFileSync(path.join(own, "draft.json"), "{}"));
const connect = (name, host, p) => new Promise((resolve) => {
  const socket = net.connect({ host, port: p, timeout: 3000 });
  socket.once("connect", () => { tries[name] = "connected"; socket.destroy(); resolve(); });
  socket.once("timeout", () => { tries[name] = "timeout"; socket.destroy(); resolve(); });
  socket.once("error", (error) => { tries[name] = error.code ?? "error"; resolve(); });
});
await connect("connect to github.com:443", "github.com", 443);
await connect("connect to a listener on this machine's loopback", "127.0.0.1", Number(port));
await connect("connect to the metadata address", "169.254.169.254", 443);
process.stdout.write(JSON.stringify(tries));
`;

describe.skipIf(!usable)("the hostile fake agent under the survey's own sandbox block and real bubblewrap (OS-sandbox tier)", () => {
  let root: string;
  let ws: string;
  let own: string;
  let outside: string;
  let listener: net.Server;
  let hits = 0;
  let block: { filesystem: { allowWrite: string[]; denyWrite: string[] }; network: { allowedDomains: string[] } };
  let tries: Record<string, string>;
  let privatePath: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpRoot(), "survey-hostile-")));
    ws = path.join(root, "work", "w1");
    own = path.join(root, "tmp", "rn-1");
    outside = path.join(root, "neighbour");
    mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
    mkdirSync(own, { recursive: true, mode: 0o700 });
    mkdirSync(outside);
    writeFileSync(path.join(ws, "README.md"), "# fixture\n");
    writeFileSync(path.join(ws, ".git", "config"), "[core]\n");
    writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
    // a listener on this machine's loopback: the "blocked address" the agent must not reach
    listener = net.createServer((socket) => void (hits += 1, socket.destroy()));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as net.AddressInfo).port;
    // the survey's real block
    block = sandboxSettings({ workspace: ws, tempDir: own, home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin"), workspaceRoot: path.join(root, "work"), tempRoot: path.join(root, "tmp"), readOnlyWorkspace: true }) as typeof block;
    // the private PATH: one directory holding the fake agent, and nothing else (the `claude` name is not used for it)
    const bin = path.join(root, "bin-private");
    mkdirSync(bin);
    writeFileSync(path.join(root, "hostile.mjs"), HOSTILE);
    symlinkSync(process.execPath, path.join(bin, "fake-agent"));
    privatePath = bin;
    for (const name of ["claude", "gh", "git-credential-store", "git-credential-cache", "git-credential-manager", "git-credential-osxkeychain", "git-credential-libsecret"]) expect(findOnPath(name, privatePath), `${name} must be unreachable on the private PATH`).toBeUndefined();
    const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-net", "--clearenv", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev"];
    for (const p of block.filesystem.allowWrite) if (existsSync(p)) args.push("--bind", p, p);
    for (const p of block.filesystem.denyWrite) if (existsSync(p)) args.push("--ro-bind", p, p);
    args.push("--setenv", "PATH", privatePath, "--setenv", "TMPDIR", own, "--chdir", ws, "--", path.join(bin, "fake-agent"), path.join(root, "hostile.mjs"), ws, own, outside, String(port));
    const ran = spawnSync(BWRAP as string, args, { encoding: "utf8", timeout: 60_000, env: { PATH: privatePath } });
    if (ran.status !== 0) throw new Error(`the hostile agent did not run: ${ran.stderr.slice(0, 400)}`);
    tries = JSON.parse(ran.stdout) as Record<string, string>;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(`/tmp/fx-survey-hostile-${process.pid}`, { force: true });
  });

  it("the block is the survey's: the temp directory is the only write grant, the working copy is denied", () => {
    expect(block.filesystem.allowWrite).toEqual([own]);
    expect(block.filesystem.denyWrite).toContain(ws);
    expect(block.network.allowedDomains).toEqual(["api.anthropic.com"]);
  });

  it("every write outside the run's temp directory is refused: the working copy, its .git, a neighbour, /tmp and a link through the temp directory", () => {
    for (const name of ["new file in the working copy", "change a file in the working copy", "make a directory in the working copy", "write into the working copy's .git", "change the working copy's .git config", "write in a neighbouring directory", "write in the machine's /tmp", "write a file named like the run's own directory, outside it", "write through a link in the temp directory that points into the working copy"]) {
      expect(tries[name], name).toBe("EROFS");
    }
  });

  it("nothing of it is on the disk afterwards", () => {
    expect(existsSync(path.join(ws, "hostile.txt"))).toBe(false);
    expect(readFileSync(path.join(ws, "README.md"), "utf8")).toBe("# fixture\n");
    expect(existsSync(path.join(ws, "newdir"))).toBe(false);
    expect(existsSync(path.join(ws, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(path.join(ws, ".git", "config"), "utf8")).toBe("[core]\n");
    expect(existsSync(path.join(outside, "neighbour.txt"))).toBe(false);
    expect(existsSync(`/tmp/fx-survey-hostile-${process.pid}`)).toBe(false);
    expect(existsSync(`${own}-sibling`)).toBe(false);
    expect(existsSync(path.join(ws, "through.txt"))).toBe(false);
  });

  it("control: the one allowed write, its own answer in the run's temp directory, works (so the refusals are the policy, not a broken sandbox)", () => {
    expect(tries["write its own answer in its temp directory (the one allowed write)"]).toBe("written");
    expect(readFileSync(path.join(own, "draft.json"), "utf8")).toBe("{}");
    expect(readlinkSync(path.join(own, "link"))).toBe(ws);
  });

  it("it reaches nothing: not github.com, not a listener on this machine's loopback, not the metadata address", () => {
    for (const name of ["connect to github.com:443", "connect to a listener on this machine's loopback", "connect to the metadata address"]) expect(["connected", "written"], name).not.toContain(tries[name]);
    expect(hits).toBe(0);
  });

  it("the settings the survey's real file carries for these paths are the same block and the same read-only denies (the file is built from it)", () => {
    const file = settingsFor(SURVEY_ROLE, block as unknown as Record<string, unknown>, ws, protectedPaths({ home: path.join(root, "home"), stateDir: path.join(root, "home", ".fx-runner"), binaryDir: path.join(root, "bin") })) as { sandbox: typeof block; permissions: { allow: string[] } };
    expect(file.sandbox.filesystem.allowWrite).toEqual([own]);
    expect(JSON.stringify(file.permissions.allow)).not.toMatch(/Edit|Write|Bash/);
  });
});
