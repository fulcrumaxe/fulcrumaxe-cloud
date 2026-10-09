import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import { cleanEnv, LOGIN_SHELL_MARKERS } from "../src/job/cleanEnv.js";
import { createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { bwrapArgs } from "../src/sandbox/probe.js";
import { sandboxSettings, TOOLCHAIN_PREFIX_CREDENTIAL_FILES } from "../src/sandbox/sandboxSettings.js";
import { describeToolchain, resolveToolchain, toolchainPathDirs, toolchainReadPaths, toolchainReport, TOOLCHAIN_TOOLS } from "../src/sandbox/toolchain.js";

/** Written out here, not imported, so a change to the source list cannot quietly change what the process-level test checks. */
const CREDENTIAL_FILES_IN_PREFIX = ["etc/npmrc", "etc/gitconfig", ".npmrc", "etc/yarnrc", ".yarnrc.yml"];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake machine under one real temporary directory: a "store" outside the home directory, a home directory, and the runner's own places. */
function machine(over: { stateOutsideHome?: boolean; binaryDirName?: string } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fxr-toolchain-")));
  roots.push(root);
  const home = path.join(root, "home");
  const store = path.join(root, "store");
  const stateDir = over.stateOutsideHome === true ? path.join(root, "state") : path.join(home, ".fx-runner");
  const binaryDir = path.join(home, over.binaryDirName ?? ".local/bin");
  for (const dir of [home, store, stateDir, binaryDir]) mkdirSync(dir, { recursive: true });
  const put = (dir: string, name: string, body = "#!/bin/sh\necho ok\n"): string => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
    return file;
  };
  return { root, home, store, stateDir, binaryDir, put, facts: { home, stateDir, binaryDir } };
}

describe("toolchain resolution (D1, D2)", () => {
  it("D1: node in a store directory and pnpm under the home directory: both on PATH, only the pnpm prefix granted, home still denied", () => {
    const m = machine();
    const nodeBin = path.join(m.store, "x-nodejs", "bin");
    m.put(nodeBin, "node");
    const pnpmDir = path.join(m.home, ".local", "share", "pnpm");
    m.put(pnpmDir, "pnpm");
    const toolchain = resolveToolchain([nodeBin, pnpmDir].join(path.delimiter), m.facts);
    expect(toolchain.tools.map((tool) => tool.name)).toEqual(["node", "pnpm"]);
    expect(toolchain.missing).toEqual(["npm", "npx", "yarn", "git"]);
    expect(toolchainPathDirs(toolchain)).toEqual([nodeBin, pnpmDir]);
    expect(toolchainReadPaths(toolchain)).toEqual([pnpmDir]);

    // Through the real builder: the grants arrive as the job's read paths and the home directory stays hidden.
    const blocks: Array<{ filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] } }> = [];
    const runtime: AgentRuntime = { start: async (opts) => ({ handle: { runId: opts.runId, done: Promise.resolve() } }), stop: async () => undefined, resume: async (handle) => ({ handle }) };
    const tempRoot = path.join(m.root, "temp");
    const workspaceRoot = path.join(m.root, "workspaces");
    mkdirSync(workspaceRoot, { recursive: true });
    const envOptions = { extraPathDirs: toolchainPathDirs(toolchain) };
    const host = createHostSandbox({
      credentials: { mode: "subscription" },
      envOptions,
      makeRuntime: (sandbox) => {
        blocks.push(sandbox as (typeof blocks)[number]);
        return runtime;
      },
      home: m.home,
      stateDir: m.stateDir,
      binaryDir: m.binaryDir,
      tempRoot,
      workspaceRoot,
      toolchainReadPaths: toolchainReadPaths(toolchain),
    });
    const workdir = path.join(workspaceRoot, "run-1");
    mkdirSync(workdir, { recursive: true });
    return host.createSandbox({ sandboxName: "rn-1", retention: { persistent: false }, timeoutMs: 1_000 }).then((handle) => {
      host.startDetached(handle, {
        runId: "run-1", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir, capUsd: 0,
        networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }, envOptions), onEvent: () => undefined,
      });
      expect(blocks).toHaveLength(1);
      const fs = blocks[0]!.filesystem;
      expect(fs.allowRead).toEqual([workdir, path.join(tempRoot, "rn-1"), pnpmDir]);
      expect(fs.denyRead).toContain(m.home);
      expect(fs.allowWrite).not.toContain(pnpmDir);
      for (const file of CREDENTIAL_FILES_IN_PREFIX) expect(fs.denyRead, file).toContain(path.join(pnpmDir, file));
      expect(cleanEnv({ mode: "subscription" }, envOptions).PATH?.split(":")).toEqual(expect.arrayContaining([nodeBin, pnpmDir]));
    });
  });

  it("an install under a version-manager directory is granted by its prefix (the directory above bin), not by its parents", () => {
    const m = machine();
    const prefix = path.join(m.home, ".nvm", "versions", "node", "v22.1.0");
    m.put(path.join(prefix, "bin"), "node");
    m.put(path.join(prefix, "bin"), "npm");
    const toolchain = resolveToolchain(path.join(prefix, "bin"), m.facts);
    expect(toolchainReadPaths(toolchain)).toEqual([prefix]);
  });

  it("a profile link under the home directory resolves to the real directory it points into, so the link itself is never on PATH or granted", () => {
    const m = machine();
    const real = path.join(m.store, "profile-1", "bin");
    m.put(real, "node");
    const profile = path.join(m.home, ".nix-profile");
    symlinkSync(path.dirname(real), profile);
    const toolchain = resolveToolchain(path.join(profile, "bin"), m.facts);
    expect(toolchainPathDirs(toolchain)).toEqual([real]);
    expect(toolchainReadPaths(toolchain)).toEqual([]);
  });

  it("D2: a tool that resolves into the credential floor, the state directory or the binary directory is refused: not granted, not on PATH", () => {
    const m = machine();
    const bad = [path.join(m.home, ".ssh", "bin"), path.join(m.stateDir, "tools"), path.join(m.binaryDir, "node-dist")];
    for (const dir of bad) {
      const solo = machine();
      const target = dir.replace(m.home, solo.home);
      solo.put(target, "node");
      const toolchain = resolveToolchain(target, solo.facts);
      expect(toolchain.tools, dir).toEqual([]);
      expect(toolchain.refused.map((r) => r.name), dir).toEqual(["node"]);
      expect(toolchainPathDirs(toolchain)).toEqual([]);
      expect(toolchainReadPaths(toolchain)).toEqual([]);
    }
  });

  it("a symlink in a harmless directory whose target is inside ~/.ssh is refused too", () => {
    const m = machine();
    const secret = m.put(path.join(m.home, ".ssh", "bin"), "node");
    const harmless = path.join(m.store, "harmless", "bin");
    mkdirSync(harmless, { recursive: true });
    symlinkSync(secret, path.join(harmless, "node"));
    const toolchain = resolveToolchain(harmless, m.facts);
    expect(toolchain.refused.map((r) => r.name)).toEqual(["node"]);
    expect(toolchainPathDirs(toolchain)).toEqual([]);
  });

  it("a tool directly in a broad directory (the home directory, ~/.cache, ~/.local/bin) is refused rather than granting everything beside it", () => {
    // The agent binary lives elsewhere here, so the protected list is not what refuses these: the broad-directory rule is.
    const m = machine({ binaryDirName: ".fx-agent" });
    m.put(path.join(m.home, ".cache"), "node");
    m.put(path.join(m.home, ".local", "bin"), "npm");
    m.put(m.home, "pnpm");
    const toolchain = resolveToolchain([path.join(m.home, ".cache"), path.join(m.home, ".local", "bin"), m.home].join(path.delimiter), m.facts);
    expect(toolchain.tools).toEqual([]);
    expect(toolchain.refused.map((r) => r.name)).toEqual(["node", "npm", "pnpm"]);
  });

  it("a prefix the builder's own rules refuse (a socket name) is refused here too, so no job would fail on it later", () => {
    const m = machine();
    m.put(path.join(m.home, "tools", "agent.sock", "bin"), "node");
    const toolchain = resolveToolchain(path.join(m.home, "tools", "agent.sock", "bin"), m.facts);
    expect(toolchain.tools).toEqual([]);
    expect(toolchain.refused.map((r) => r.name)).toEqual(["node"]);
  });

  it("a runner state directory outside the home directory is guarded as well: a tool inside it is refused", () => {
    const m = machine({ stateOutsideHome: true });
    m.put(path.join(m.stateDir, "tools", "bin"), "node");
    const toolchain = resolveToolchain(path.join(m.stateDir, "tools", "bin"), m.facts);
    expect(toolchain.tools).toEqual([]);
    expect(toolchain.refused.map((r) => r.name)).toEqual(["node"]);
  });

  it("the builder itself still refuses a toolchain grant over a credential location, the home directory or the mirrors root", () => {
    const m = machine();
    const workspaceRoot = path.join(m.root, "workspaces");
    const tempRoot = path.join(m.root, "temp");
    const mirrorsRoot = path.join(m.home, ".cache", "fx-runner", "mirrors");
    const base = { workspace: path.join(workspaceRoot, "w"), tempDir: path.join(tempRoot, "t"), home: m.home, stateDir: m.stateDir, binaryDir: m.binaryDir, workspaceRoot, tempRoot, mirrorsRoot };
    for (const bad of [path.join(m.home, ".ssh"), path.join(m.home, ".ssh", "x"), m.home, m.stateDir, path.join(m.home, ".cache"), path.join(mirrorsRoot, "r.git")]) {
      expect(() => sandboxSettings({ ...base, toolchainReadPaths: [bad] }), bad).toThrow(/overlaps|may not be|mirrors root/);
    }
    expect(() => sandboxSettings({ ...base, toolchainReadPaths: [path.join(m.home, ".nvm", "v1")] })).not.toThrow();
  });

  it("relative search entries and non-executable files are not tools; a missing tool is only listed as missing", () => {
    const m = machine();
    const dir = path.join(m.store, "odd", "bin");
    mkdirSync(path.join(dir, "node"), { recursive: true });
    writeFileSync(path.join(dir, "git"), "x", { mode: 0o644 });
    const toolchain = resolveToolchain(["relative/bin", dir].join(path.delimiter), m.facts);
    expect(toolchain.tools).toEqual([]);
    expect(toolchain.missing).toEqual([...TOOLCHAIN_TOOLS]);
  });

  it("doctor text: node missing says projects cannot run their tests; a refused tool is named", () => {
    const m = machine();
    const none = describeToolchain(resolveToolchain("", m.facts));
    expect(none.line).toBe("none found");
    expect(none.warnings).toContain("node not found: projects that need it cannot run their tests");
    m.put(path.join(m.store, "n", "bin"), "node");
    const some = describeToolchain(resolveToolchain(path.join(m.store, "n", "bin"), m.facts));
    expect(some.line).toBe("found node");
    expect(some.warnings).toEqual([]);
  });
});

describe("credential files inside a granted prefix (fix round 1)", () => {
  function settingsFor(m: ReturnType<typeof machine>, grants: string[]) {
    const workspaceRoot = path.join(m.root, "workspaces");
    const tempRoot = path.join(m.root, "temp");
    return sandboxSettings({ workspace: path.join(workspaceRoot, "w"), tempDir: path.join(tempRoot, "t"), home: m.home, stateDir: m.stateDir, binaryDir: m.binaryDir, workspaceRoot, tempRoot, toolchainReadPaths: grants }) as {
      filesystem: { denyRead: string[]; allowRead: string[] };
      credentials: { files: Array<{ path: string; mode: string }> };
    };
  }

  it("the constant list names the npm, yarn and git config files, and every granted prefix gets each of them denied for read and as a credential file", () => {
    expect([...TOOLCHAIN_PREFIX_CREDENTIAL_FILES].sort()).toEqual([".npmrc", ".yarnrc.yml", "etc/gitconfig", "etc/npmrc", "etc/yarnrc"]);
    const m = machine();
    const prefix = path.join(m.home, ".nvm", "versions", "node", "v22.1.0");
    mkdirSync(prefix, { recursive: true });
    const settings = settingsFor(m, [prefix]);
    for (const file of CREDENTIAL_FILES_IN_PREFIX) {
      expect(settings.filesystem.denyRead, file).toContain(path.join(prefix, file));
      expect(settings.credentials.files, file).toContainEqual({ path: path.join(prefix, file), mode: "deny" });
    }
    // The prefix itself is still readable, and the floor is still there.
    expect(settings.filesystem.allowRead).toContain(prefix);
    expect(settings.credentials.files).toContainEqual({ path: path.join(m.home, ".ssh"), mode: "deny" });
    expect(settings.filesystem.denyRead).toContain(m.home);
  });

  it("with no toolchain grant, nothing is added", () => {
    const m = machine();
    const settings = settingsFor(m, []);
    expect(settings.credentials.files.map((entry) => entry.path).every((file) => file.startsWith(path.join(m.home, "."))|| file.includes("Keychains"))).toBe(true);
    expect(settings.filesystem.denyRead.some((entry) => entry.endsWith("npmrc"))).toBe(false);
  });
});

describe("a bin directory inside a job's own area is never used (fix round 1)", () => {
  it("a tool under the workspaces, the job temp directories or the mirrors is refused with the job_area reason, and doctor says so", () => {
    const m = machine();
    const areas = { mirrors: path.join(m.home, ".cache", "fx-runner", "mirrors"), workspaces: path.join(m.home, ".cache", "fx-runner", "workspaces"), temp: path.join(m.home, ".cache", "fx-runner", "temp") };
    const jobAreas = Object.values(areas);
    for (const [name, area] of Object.entries(areas)) {
      const bin = path.join(area, "job-1", "node_modules", ".bin");
      m.put(bin, "node");
      const toolchain = resolveToolchain(bin, { ...m.facts, jobAreas });
      expect(toolchain.tools, name).toEqual([]);
      expect(toolchain.refused, name).toEqual([{ name: "node", found: path.join(bin, "node"), reason: "job_area" }]);
      expect(toolchainPathDirs(toolchain)).toEqual([]);
      expect(toolchainReadPaths(toolchain)).toEqual([]);
      expect(describeToolchain(toolchain).warnings.join("\n"), name).toContain("inside the directories jobs work in");
    }
  });

  it("a symlink from a harmless directory into a job area is refused too", () => {
    const m = machine();
    const area = path.join(m.home, ".cache", "fx-runner", "workspaces");
    const real = m.put(path.join(area, "w1", "bin"), "node");
    const harmless = path.join(m.store, "link-bin");
    mkdirSync(harmless, { recursive: true });
    symlinkSync(real, path.join(harmless, "node"));
    const toolchain = resolveToolchain(harmless, { ...m.facts, jobAreas: [area] });
    expect(toolchain.tools).toEqual([]);
    expect(toolchain.refused.map((tool) => tool.reason)).toEqual(["job_area"]);
  });

  it("a tool beside a job area (not under it) and with no areas given resolves as before; the doctor report passes the real roots", () => {
    const m = machine();
    const area = path.join(m.home, ".cache", "fx-runner", "workspaces");
    const sibling = path.join(m.home, ".cache", "fx-runner", "workspaces-extra");
    m.put(path.join(sibling, "bin"), "node");
    expect(resolveToolchain(path.join(sibling, "bin"), { ...m.facts, jobAreas: [area] }).tools.map((tool) => tool.name)).toEqual(["node"]);
    // Through the doctor report, with the cache directory the runner really uses on Linux.
    const cache = path.join(m.home, ".cache", "fx-runner");
    const bad = path.join(cache, "workspaces", "w", "bin");
    m.put(bad, "node");
    const report = toolchainReport(bad, { home: m.home, stateDir: m.stateDir, binaryPath: path.join(m.binaryDir, "claude"), platform: "linux", xdgCacheHome: path.join(m.home, ".cache") });
    expect(report?.level).toBe("WARN");
    expect(report?.warnings.join("\n")).toContain("inside the directories jobs work in");
  });
});

describe("the login-shell marker (the way PATH reaches the agent's Bash tool)", () => {
  it("is copied only when the host has it set to 1, by name, and nothing else of its kind", () => {
    expect([...LOGIN_SHELL_MARKERS]).toEqual(["__NIXOS_SET_ENVIRONMENT_DONE"]);
    const before = process.env.__NIXOS_SET_ENVIRONMENT_DONE;
    try {
      process.env.__NIXOS_SET_ENVIRONMENT_DONE = "1";
      expect(cleanEnv({ mode: "subscription" }).__NIXOS_SET_ENVIRONMENT_DONE).toBe("1");
      process.env.__NIXOS_SET_ENVIRONMENT_DONE = "0";
      expect(cleanEnv({ mode: "subscription" })).not.toHaveProperty("__NIXOS_SET_ENVIRONMENT_DONE");
      delete process.env.__NIXOS_SET_ENVIRONMENT_DONE;
      expect(cleanEnv({ mode: "subscription" })).not.toHaveProperty("__NIXOS_SET_ENVIRONMENT_DONE");
    } finally {
      if (before === undefined) delete process.env.__NIXOS_SET_ENVIRONMENT_DONE;
      else process.env.__NIXOS_SET_ENVIRONMENT_DONE = before;
    }
  });
});

describe.skipIf(!existsSync("/etc/set-environment"))("a real login shell on NixOS (the CLI's Bash tool starts one)", () => {
  const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  const nodeDir = path.dirname(process.execPath);
  const where = (env: Record<string, string>): string => spawnSync(bash, ["-lc", "command -v node"], { env, encoding: "utf8" }).stdout;
  it("keeps the PATH it is given when the marker is set, and replaces it with the system's when it is not", () => {
    const base = { HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", PATH: `${nodeDir}:${path.dirname(bash)}` };
    expect(where({ ...base, __NIXOS_SET_ENVIRONMENT_DONE: "1" })).toContain(path.join(nodeDir, "node"));
    // The control: without the marker the system profile resets PATH, which is what dropped node from the first real runner build.
    expect(where(base)).not.toContain(path.join(nodeDir, "node"));
  });
});

/** Whether this machine can start bubblewrap with the user namespace the sandbox uses; a reason when it cannot. */
function bwrapSkipReason(): string | undefined {
  const found = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" });
  if (found.status !== 0) return "bubblewrap is not installed";
  const bwrap = found.stdout.trim();
  const tried = spawnSync(bwrap, ["--unshare-user", "--ro-bind", "/", "/", "--", "/bin/sh", "-c", "true"], { encoding: "utf8" });
  return tried.status === 0 ? undefined : `bubblewrap cannot start here: ${tried.stderr.split("\n")[0] ?? ""}`;
}
const skip = bwrapSkipReason();

describe.skipIf(skip !== undefined)(`D3 (process level): a real bubblewrap sandbox with the job's rules runs node and git by name${skip === undefined ? "" : ` (skipped: ${skip})`}`, () => {
  function runInSandbox(m: ReturnType<typeof machine>, grants: string[], pathDirs: string[], command: string, withoutToolchainDeny = false): { status: number | null; stdout: string; stderr: string } {
    const workspaceRoot = path.join(m.root, "workspaces");
    const tempRoot = path.join(m.root, "temp");
    const workspace = path.join(workspaceRoot, "w");
    const tempDir = path.join(tempRoot, "t");
    for (const dir of [workspace, tempDir]) mkdirSync(dir, { recursive: true });
    const settings = sandboxSettings({ workspace, tempDir, home: m.home, stateDir: m.stateDir, binaryDir: m.binaryDir, workspaceRoot, tempRoot, toolchainReadPaths: grants });
    if (withoutToolchainDeny) {
      // The control: the same settings with only the toolchain files taken out of the two deny lists.
      const denied = new Set(grants.flatMap((grant) => CREDENTIAL_FILES_IN_PREFIX.map((file) => path.join(grant, file))));
      const block = settings as { filesystem: { denyRead: string[] }; credentials: { files: Array<{ path: string }> } };
      block.filesystem.denyRead = block.filesystem.denyRead.filter((entry) => !denied.has(entry));
      block.credentials.files = block.credentials.files.filter((entry) => !denied.has(entry.path));
    }
    const bwrap = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim();
    const env = { PATH: [...pathDirs, path.dirname(spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim())].join(":"), LC_ALL: "C" };
    const isFile = (target: string): boolean => {
      try {
        return statSync(target).isFile();
      } catch {
        return false;
      }
    };
    const args = [...bwrapArgs(settings, (target) => spawnSync("test", ["-d", target]).status === 0, isFile), "--", "/bin/sh", "-c", command];
    return spawnSync(bwrap, args, { env, encoding: "utf8", timeout: 20_000 });
  }

  it("a version-manager node under the home directory runs with the install prefix granted, and not without it (control)", () => {
    const m = machine();
    const prefix = path.join(m.home, ".nvm", "versions", "node", "v22.1.0");
    m.put(path.join(prefix, "bin"), "node", "#!/bin/sh\necho v22.1.0\n");
    const toolchain = resolveToolchain(path.join(prefix, "bin"), m.facts);
    const granted = runInSandbox(m, toolchainReadPaths(toolchain), toolchainPathDirs(toolchain), "node --version");
    expect(granted.stderr).toBe("");
    expect(granted.stdout.trim()).toBe("v22.1.0");
    expect(granted.status).toBe(0);
    // The control: the same PATH with no grant cannot see the install, because the home directory is hidden.
    const control = runInSandbox(m, [], [path.join(prefix, "bin")], "node --version");
    expect(control.status).not.toBe(0);
  });

  it("the machine's own git is reachable by name with the same rules", () => {
    const m = machine();
    const found = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    expect(found).not.toBe("");
    const toolchain = resolveToolchain(path.dirname(found), m.facts);
    if (toolchain.tools.some((tool) => tool.name === "git")) {
      const result = runInSandbox(m, toolchainReadPaths(toolchain), toolchainPathDirs(toolchain), "git --version");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^git version /);
    }
  });

  it("fix round 1: inside a granted prefix, the global npm config and the other credential files cannot be read while node still runs; without the deny the same read succeeds (control)", () => {
    const m = machine();
    const prefix = path.join(m.home, ".nvm", "versions", "node", "v22.1.0");
    m.put(path.join(prefix, "bin"), "node", "#!/bin/sh\necho v22.1.0\n");
    for (const file of CREDENTIAL_FILES_IN_PREFIX) {
      mkdirSync(path.dirname(path.join(prefix, file)), { recursive: true });
      writeFileSync(path.join(prefix, file), `//registry.example.test/:_authToken=SECRET-${file}\n`);
    }
    // A harmless file in the same prefix stays readable: the grant is not narrowed beyond the named files.
    writeFileSync(path.join(prefix, "etc", "other.txt"), "plain\n");
    const toolchain = resolveToolchain(path.join(prefix, "bin"), m.facts);
    const grants = toolchainReadPaths(toolchain);
    expect(grants).toEqual([prefix]);
    const dirs = toolchainPathDirs(toolchain);

    const node = runInSandbox(m, grants, dirs, "node --version");
    expect(node.status).toBe(0);
    expect(node.stdout.trim()).toBe("v22.1.0");
    const other = runInSandbox(m, grants, dirs, `IFS= read -r line < ${path.join(prefix, "etc", "other.txt")} && echo "$line"`);
    expect(other.stderr).toBe("");
    expect(other.stdout.trim()).toBe("plain");

    for (const file of CREDENTIAL_FILES_IN_PREFIX) {
      const denied = runInSandbox(m, grants, dirs, `IFS= read -r line < ${path.join(prefix, file)} && echo "$line"`);
      // Bound over with an empty file, so the read gives nothing; the token never comes out.
      expect(denied.stdout, file).toBe("");
      const control = runInSandbox(m, grants, dirs, `IFS= read -r line < ${path.join(prefix, file)} && echo "$line"`, true);
      expect(control.status, file).toBe(0);
      expect(control.stdout, file).toContain(`SECRET-${file}`);
    }
  });
});
