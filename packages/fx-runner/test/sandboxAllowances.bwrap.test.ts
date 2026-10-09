import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bwrapArgs } from "../src/sandbox/probe.js";
import { grantsOf } from "../src/sandbox/allowances.js";
import { sandboxSettings } from "../src/sandbox/sandboxSettings.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";

/**
 * D#6 R7b, with real bubblewrap. The rules come from the one builder (`sandboxSettings`) with a job's allowances applied, are translated by the
 * probe's own translation (`bwrapArgs`, the code `doctor` runs), and commands run for real inside them. Canaries sit in every place the
 * floor protects and must stay unreadable and unwritable with the allowances ON; each allowance has a control that shows it takes effect.
 * The translation has no network (the namespace is unshared), so domains and the loopback bind are proved on the settings, and live in R7e.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const usable = ((): boolean => {
  if (BWRAP === undefined) return false;
  return bwrapCanCreateNamespaces(BWRAP);
})();

const CANARY = "FX-R7B-CANARY-b1946ac92492d2347c6235b4d2611184";
let root: string;
let home: string;
let scratch: string;
let readOnlyDir: string;
let storeRoot: string;
let store: string;
let otherStore: string;
let tempDir: string;
let workspace: string;
let settings: Record<string, unknown>;

/** Runs `script` in the job's sandbox. The environment is the whole of it: the job's own cache directory, nothing from this shell. */
function inSandbox(script: string): { code: number | null; stdout: string; stderr: string } {
  const args = [...bwrapArgs(settings, (target) => existsSync(target) && statSync(target).isDirectory(), (target) => existsSync(target) && statSync(target).isFile()), "--", "/bin/sh", "-c", script];
  const out = spawnSync(BWRAP!, args, { env: { PATH: "/run/current-system/sw/bin:/usr/bin:/bin", HOME: home, XDG_CACHE_HOME: path.join(tempDir, "xdg-cache") }, encoding: "utf8", timeout: 20_000 });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

function build(allowances: Array<{ kind: "path" | "domain" | "loopback"; value: string; access: "read" | "write" | "connect" | "bind"; reason: string }>): Record<string, unknown> {
  const grants = grantsOf(allowances);
  return sandboxSettings({
    workspace, tempDir, home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(root, "bin"),
    workspaceRoot: path.dirname(workspace), tempRoot: path.dirname(tempDir),
    allowanceReadPaths: grants.readPaths, allowanceWritePaths: grants.writePaths, extraDomains: grants.domains, allowLoopbackBind: grants.loopback,
    packageStore: { root: storeRoot, dir: store },
  });
}

describe.skipIf(!usable)("R7b: the allowances in a real bubblewrap sandbox", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join("/tmp", "r7b-bwrap-"));
    home = path.join(root, "home");
    workspace = path.join(home, ".cache", "fx-runner", "workspaces", "run-1");
    tempDir = path.join(home, ".cache", "fx-runner", "tmp", "rn-1");
    storeRoot = path.join(home, ".cache", "fx-runner", "pnpm-store");
    store = path.join(storeRoot, "acme__widgets");
    otherStore = path.join(storeRoot, "acme__other");
    scratch = path.join(root, "scratch");
    readOnlyDir = path.join(root, "shared-read");
    for (const dir of [workspace, tempDir, path.join(tempDir, "xdg-cache"), store, otherStore, scratch, readOnlyDir, path.join(root, "bin")]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(readOnlyDir, "data.txt"), "readable-data");
    // a canary in every place the floor protects, in the other repo's store, in the state directory and in the home directory itself
    const planted = [".ssh/id_ed25519", ".aws/credentials", ".config/gh/hosts.yml", ".claude.json", ".config/fx-runner/key", ".gnupg/secring", ".netrc", ".npmrc", ".bashrc", ".fx-runner/jobs.json", "notes.txt", ".cache/fx-runner/pnpm-store/acme__other/canary"];
    for (const file of planted) {
      mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
      writeFileSync(path.join(home, file), CANARY);
    }
    settings = build([
      { kind: "path", value: readOnlyDir, access: "read", reason: "shared data" },
      { kind: "path", value: scratch, access: "write", reason: "scratch" },
      { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install" },
      { kind: "loopback", value: "127.0.0.1", access: "bind", reason: "test database" },
    ]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("control: the sandbox runs, a write allowance is writable and the job's own places still work", () => {
    expect(inSandbox("echo ok").stdout.trim()).toBe("ok");
    const wrote = inSandbox(`echo allowed > ${scratch}/f && cat ${scratch}/f`);
    expect(wrote.stdout.trim()).toBe("allowed");
    expect(readFileSync(path.join(scratch, "f"), "utf8").trim()).toBe("allowed");
    expect(inSandbox(`echo x > ${workspace}/w && echo y > ${tempDir}/xdg-cache/c`).code).toBe(0);
  });

  it("control: without the allowance the same write fails and leaves nothing (the allowance is what lets it through)", () => {
    const without = build([]);
    const previous = settings;
    settings = without;
    const denied = inSandbox(`echo nope > ${scratch}/g`);
    settings = previous;
    expect(denied.code).not.toBe(0);
    expect(existsSync(path.join(scratch, "g"))).toBe(false);
  });

  it("control: the repo's store is writable and holds its data, and a read allowance is readable", () => {
    expect(inSandbox(`echo pkg > ${store}/pkg && cat ${store}/pkg`).stdout.trim()).toBe("pkg");
    expect(inSandbox(`cat ${readOnlyDir}/data.txt`).stdout).toBe("readable-data");
  });

  it("a read allowance is read-only: a write into it fails", () => {
    expect(inSandbox(`echo x > ${readOnlyDir}/h`).code).not.toBe(0);
    expect(existsSync(path.join(readOnlyDir, "h"))).toBe(false);
  });

  it("canaries: with every allowance applied, no credential, shell file, state file or other repo's store can be read", () => {
    const files = [".ssh/id_ed25519", ".aws/credentials", ".config/gh/hosts.yml", ".claude.json", ".config/fx-runner/key", ".gnupg/secring", ".netrc", ".npmrc", ".bashrc", ".fx-runner/jobs.json", "notes.txt", ".cache/fx-runner/pnpm-store/acme__other/canary"];
    for (const file of files) {
      const out = inSandbox(`cat ${path.join(home, file)}`);
      expect(out.stdout, file).not.toContain(CANARY);
      expect(out.code, file).not.toBe(0);
    }
    const listing = inSandbox(`ls -A ${home} ${home}/.cache/fx-runner/pnpm-store 2>&1; cat ~/.bashrc 2>&1`);
    expect(listing.stdout).not.toContain(CANARY);
    expect(listing.stdout).not.toContain(".ssh");
    expect(listing.stdout).not.toContain("acme__other");
  });

  it("canaries: nothing outside the allowances can be written, with the allowances applied", () => {
    // The home directory is a scratch tmpfs inside the sandbox, so a write there succeeds and vanishes; what counts is that the host never sees it.
    for (const target of [path.join(home, "fx-probe"), path.join(home, ".bashrc"), path.join(otherStore, "x")]) inSandbox(`echo pwned > ${target}`);
    for (const target of ["/etc/fx-probe", path.join(root, "outside"), path.join(root, "shared-read", "x")]) {
      expect(inSandbox(`echo pwned > ${target}`).code, target).not.toBe(0);
    }
    expect(existsSync(path.join(otherStore, "x"))).toBe(false);
    expect(existsSync(path.join(home, "fx-probe"))).toBe(false);
    expect(existsSync("/etc/fx-probe")).toBe(false);
    expect(readFileSync(path.join(home, ".bashrc"), "utf8")).toBe(CANARY);
    expect(existsSync(path.join(root, "outside"))).toBe(false);
  });

  it("no process of the job outlives it (--die-with-parent)", () => {
    const marker = `sleep ${3000 + (process.pid % 900)}`;
    expect(inSandbox(`${marker} & sleep 0.3; echo started`).stdout.trim()).toBe("started");
    expect(spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim()).toBe("");
  });

  it("the settings carry the domain and the loopback bind that the translation cannot show", () => {
    const network = settings.network as { allowedDomains: string[]; allowLocalBinding: boolean; strictAllowlist: boolean };
    expect(network.allowedDomains).toEqual(["api.anthropic.com", "registry.npmjs.org"]);
    expect(network.allowLocalBinding).toBe(true);
    expect(network.strictAllowlist).toBe(true);
    expect(settings.allowUnsandboxedCommands).toBe(false);
    expect(settings.enableWeakerNestedSandbox).toBe(false);
  });
});

/**
 * The cache directory follows any absolute `XDG_CACHE_HOME`, so the runner's workspaces, temp directories and package stores can sit OUTSIDE the home
 * directory. Then the home directory's `denyRead` hides nothing of them, and each root must be denied itself, with only this job's own child re-allowed.
 */
describe.skipIf(!usable)("R7b: the runner's roots with the cache directory outside the home directory", () => {
  let base: string;
  let cacheHome: string;
  let own: { workspace: string; tempDir: string; store: string };
  let blocks: Record<string, unknown>;
  let weakened: Record<string, unknown>;
  const OTHER = { workspace: "workspaces/run-2", tempDir: "tmp/rn-2", store: "pnpm-store/other-repo-id" };

  function run(block: Record<string, unknown>, script: string): { code: number | null; stdout: string } {
    const args = [...bwrapArgs(block, (target) => existsSync(target) && statSync(target).isDirectory(), (target) => existsSync(target) && statSync(target).isFile()), "--", "/bin/sh", "-c", script];
    const out = spawnSync(BWRAP!, args, { env: { PATH: "/run/current-system/sw/bin:/usr/bin:/bin", HOME: path.join(base, "home") }, encoding: "utf8", timeout: 20_000 });
    return { code: out.status, stdout: out.stdout };
  }

  beforeAll(() => {
    base = mkdtempSync(path.join("/tmp", "r7b-outside-home-"));
    cacheHome = path.join(base, "cache", "fx-runner");
    const home = path.join(base, "home");
    const storeRoot = path.join(cacheHome, "pnpm-store");
    own = { workspace: path.join(cacheHome, "workspaces", "run-1"), tempDir: path.join(cacheHome, "tmp", "rn-1"), store: path.join(storeRoot, "this-repo-id") };
    for (const dir of [home, path.join(base, "bin"), own.workspace, own.tempDir, own.store]) mkdirSync(dir, { recursive: true });
    for (const other of Object.values(OTHER)) {
      mkdirSync(path.join(cacheHome, other), { recursive: true });
      writeFileSync(path.join(cacheHome, other, "canary"), CANARY);
    }
    writeFileSync(path.join(own.workspace, "mine"), "own-workspace");
    writeFileSync(path.join(own.tempDir, "mine"), "own-temp");
    writeFileSync(path.join(own.store, "mine"), "own-store");
    blocks = sandboxSettings({
      workspace: own.workspace, tempDir: own.tempDir, home, stateDir: path.join(home, ".fx-runner"), binaryDir: path.join(base, "bin"),
      workspaceRoot: path.join(cacheHome, "workspaces"), tempRoot: path.join(cacheHome, "tmp"),
      allowanceReadPaths: [], allowanceWritePaths: [], packageStoreRoot: storeRoot, packageStore: { root: storeRoot, dir: own.store },
    });
    // the same block with the three roots taken out of denyRead: what this PR's base did when the cache was outside the home directory
    const filesystem = blocks.filesystem as { denyRead: string[] };
    weakened = { ...blocks, filesystem: { ...filesystem, denyRead: filesystem.denyRead.filter((entry) => ![path.join(cacheHome, "workspaces"), path.join(cacheHome, "tmp"), storeRoot].includes(entry)) } };
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("control: with the roots not denied, another repo's store, another job's workspace and another job's temp directory ARE readable (the canaries can be seen)", () => {
    for (const other of Object.values(OTHER)) {
      const out = run(weakened, `cat ${path.join(cacheHome, other, "canary")}`);
      expect(out.stdout, other).toContain(CANARY);
    }
  });

  it("control: this job's own workspace, temp directory and store are readable and writable", () => {
    for (const dir of [own.workspace, own.tempDir, own.store]) {
      expect(run(blocks, `cat ${dir}/mine`).stdout, dir).toMatch(/^own-/);
      expect(run(blocks, `echo more > ${dir}/new && cat ${dir}/new`).stdout.trim(), dir).toBe("more");
    }
  });

  it("another repo's package store is unreadable from this job, and unwritable", () => {
    const canary = path.join(cacheHome, OTHER.store, "canary");
    const out = run(blocks, `cat ${canary}`);
    expect(out.stdout).not.toContain(CANARY);
    expect(out.code).not.toBe(0);
    expect(run(blocks, `ls ${path.join(cacheHome, "pnpm-store")} 2>&1`).stdout).not.toContain("other-repo-id");
    run(blocks, `echo pwned > ${path.join(cacheHome, OTHER.store, "x")}`);
    expect(existsSync(path.join(cacheHome, OTHER.store, "x"))).toBe(false);
  });

  it("another job's workspace and temp directory are unreadable from this job, and unwritable", () => {
    for (const other of [OTHER.workspace, OTHER.tempDir]) {
      const out = run(blocks, `cat ${path.join(cacheHome, other, "canary")}`);
      expect(out.stdout, other).not.toContain(CANARY);
      expect(out.code, other).not.toBe(0);
      run(blocks, `echo pwned > ${path.join(cacheHome, other, "x")}`);
      expect(existsSync(path.join(cacheHome, other, "x")), other).toBe(false);
    }
    const listing = run(blocks, `ls ${path.join(cacheHome, "workspaces")} ${path.join(cacheHome, "tmp")} 2>&1`).stdout;
    expect(listing).not.toContain("run-2");
    expect(listing).not.toContain("rn-2");
  });
});
