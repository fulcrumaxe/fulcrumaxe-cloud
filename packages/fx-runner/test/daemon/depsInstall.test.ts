import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDepsInstaller, pnpmArgs, type DepsOutcome } from "../../src/daemon/depsInstall.js";
import type { InstallCapture } from "../../src/daemon/engineKit.js";
import { runInstall } from "../../src/engines/claude/capture.js";

/**
 * D#6 C44-4 (G-C44-7): the host-side install against a hostile repo. The package manager is a real executable (a small shell script standing in for
 * pnpm and npm) started through the real process-group capture, so the environment, working directory, arguments and kill behaviour are the real ones.
 */
const SHA = "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";
const HOST = "registry.npmjs.org";
const PNPM_LOCK = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: ${SHA}}\n\nsnapshots:\n\n  left-pad@1.3.0: {}\n`;
const NPM_LOCK = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: SHA } } });

let root: string;
let workspace: string;
let bin: string;
let record: string;
let STORE: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fxc444-deps-"));
  workspace = path.join(root, "ws");
  bin = path.join(root, "bin");
  record = path.join(root, "record.txt");
  STORE = path.join(root, "state", "pnpm-store", "repo-1");
  mkdirSync(workspace);
  mkdirSync(bin);
  // The stand-in managers come first on PATH, so a real pnpm on this machine is never the one that runs.
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A package manager that records how it was started, then runs `body`. */
function fakeManager(name: "pnpm" | "npm", body = "mkdir -p node_modules/.bin && : > node_modules/.bin/vitest"): void {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\n{ echo "ARGS:$*"; echo "PWD:$(pwd)"; echo "ENV-BEGIN"; env; } > '${record}'\n${body}\n`);
  chmodSync(file, 0o755);
}

function installer(opts: { capture?: InstallCapture; timeoutMs?: number } = {}) {
  const said: string[] = [];
  const calls: string[] = [];
  const real: InstallCapture = (command, args, env, cwd, timeoutMs, tail, signal) => (calls.push(command), runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal));
  const subject = createDepsInstaller({ capture: opts.capture ?? real, envOptions: { extraPathDirs: [bin] }, say: (line) => said.push(line), ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) });
  return { said, calls, run: (signal?: AbortSignal): Promise<DepsOutcome> => subject.run({ workspace, registryHost: HOST, storeDir: STORE, ...(signal === undefined ? {} : { signal }) }) };
}

const put = (name: string, text: string): void => writeFileSync(path.join(workspace, name), text);
const recorded = (): string => readFileSync(record, "utf8");
const envOfRecord = (): Record<string, string> => Object.fromEntries(recorded().split("ENV-BEGIN\n")[1]!.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("the install that runs", () => {
  it("pnpm: frozen, no scripts, no pnpmfile, registry, store and cache on the command line, inside the workspace; no secret in its environment", async () => {
    for (const [name, value] of Object.entries({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-" + "oat01-secretsecretsecret", ANTHROPIC_API_KEY: "sk-ant-" + "api03-secretsecretsecret", GH_TOKEN: "ghp_secretsecretsecretsecretsecretsecret1", GITHUB_TOKEN: "ghs_secretsecretsecretsecretsecretsecret1", NPM_TOKEN: "npm_secretsecretsecretsecretsecretsecret1", NPM_CONFIG_REGISTRY: "https://evil.example/", npm_config_userconfig: "/home/evil/.npmrc", FX_RUNNER_CONN: "conn-secret", AWS_SECRET_ACCESS_KEY: "aws-secret" })) vi.stubEnv(name, value);
    fakeManager("pnpm");
    put("pnpm-lock.yaml", PNPM_LOCK);
    put(".pnpmfile.cjs", "throw new Error('repo code must not run')");
    const r = installer();
    expect(await r.run()).toEqual({ kind: "installed" });
    const args = recorded().split("\n")[0]!.slice("ARGS:".length).split(" ");
    expect(args.slice(0, 4)).toEqual(["install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]);
    expect(args).toContain("--registry=https://registry.npmjs.org/");
    expect(args).toContain(`--config.store-dir=${STORE}`);
    expect(envOfRecord().pnpm_config_store_dir).toBe(STORE);
    expect(lstatSync(STORE).mode & 0o777).toBe(0o700);
    expect(args).toContain(`--config.cache-dir=${workspace}/node_modules/.pnpm-cache`);
    expect(recorded()).toContain(`PWD:${workspace}`);
    const env = envOfRecord();
    expect(Object.keys(env).filter((n) => /TOKEN|KEY|SECRET|CONN|GH_|GITHUB|ANTHROPIC|CLAUDE|AWS|FX_/i.test(n))).toEqual([]);
    expect(recorded()).not.toMatch(/secretsecret|conn-secret|aws-secret|evil/);
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(env.npm_config_ignore_scripts).toBe("true");
    expect(env.HOME?.startsWith(`${workspace}/node_modules/`)).toBe(true);
    expect(env.TMPDIR?.startsWith(`${workspace}/node_modules/`)).toBe(true);
    expect(env.npm_config_userconfig?.startsWith(`${workspace}/node_modules/`)).toBe(true);
    expect(existsSync(path.join(workspace, "node_modules", ".bin", "vitest"))).toBe(true);
    // The scratch (home, empty config) is gone; the lockfile is as it came.
    expect(existsSync(path.join(workspace, "node_modules", ".fx-install"))).toBe(false);
    expect(readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8")).toBe(PNPM_LOCK);
    expect(r.said).toEqual([]);
  });

  it("pnpm: the empty pnpmfiles list is added to the workspace state the install wrote, so the agent's later pnpm run finds nothing to reinstall; nothing else in it changes; and no CI variable is set", async () => {
    fakeManager("pnpm", `mkdir -p node_modules/.bin\nprintf '%s' '{"lastValidatedTimestamp":1,"projects":{},"settings":{"nodeLinker":"isolated"},"filteredInstall":false}' > node_modules/.pnpm-workspace-state-v1.json`);
    put("pnpm-lock.yaml", PNPM_LOCK);
    expect(await installer().run()).toEqual({ kind: "installed" });
    expect(JSON.parse(readFileSync(path.join(workspace, "node_modules", ".pnpm-workspace-state-v1.json"), "utf8"))).toEqual({ lastValidatedTimestamp: 1, projects: {}, settings: { nodeLinker: "isolated" }, filteredInstall: false, pnpmfiles: [] });
    expect(Object.keys(envOfRecord())).not.toContain("CI");
    expect(recorded()).toContain("--config.confirm-modules-purge=false");
    // A state that is not a plain object, or already lists pnpmfiles, is left exactly as pnpm wrote it.
    for (const text of ["[1]", "not json", '{"pnpmfiles":[".pnpmfile.cjs"]}']) {
      rmSync(path.join(workspace, "node_modules"), { recursive: true, force: true });
      fakeManager("pnpm", `mkdir -p node_modules\nprintf '%s' '${text}' > node_modules/.pnpm-workspace-state-v1.json`);
      expect(await installer().run()).toEqual({ kind: "installed" });
      expect(readFileSync(path.join(workspace, "node_modules", ".pnpm-workspace-state-v1.json"), "utf8")).toBe(text);
    }
  });

  it("npm: ci with no scripts, the pinned registry and an empty user and global config", async () => {
    fakeManager("npm");
    put("package-lock.json", NPM_LOCK);
    const r = installer();
    expect(await r.run()).toEqual({ kind: "installed" });
    const args = recorded().split("\n")[0]!.slice("ARGS:".length).split(" ");
    expect(args.slice(0, 2)).toEqual(["ci", "--ignore-scripts"]);
    expect(args).toContain("--registry=https://registry.npmjs.org/");
    expect(args.some((a) => a.startsWith(`--cache=${workspace}/node_modules/`))).toBe(true);
    expect(args.some((a) => a.startsWith("--userconfig=") && a.includes("/node_modules/.fx-install/"))).toBe(true);
  });

  it("pnpm wins when both lockfiles are real files", async () => {
    fakeManager("pnpm");
    fakeManager("npm", "echo npm ran > '" + path.join(root, "npm-ran") + "'");
    put("pnpm-lock.yaml", PNPM_LOCK);
    put("package-lock.json", NPM_LOCK);
    expect(await installer().run()).toEqual({ kind: "installed" });
    expect(recorded().startsWith("ARGS:install ")).toBe(true);
    expect(existsSync(path.join(root, "npm-ran"))).toBe(false);
  });

  it("no lockfile, or only the sandbox's empty stub of one: nothing runs and nothing is said", async () => {
    fakeManager("pnpm");
    const r = installer();
    expect(await r.run()).toEqual({ kind: "none" });
    put("pnpm-lock.yaml", "");
    put("package-lock.json", "");
    expect(await r.run()).toEqual({ kind: "none" });
    expect(r.calls).toEqual([]);
    expect(r.said).toEqual([]);
    expect(existsSync(path.join(workspace, "node_modules"))).toBe(false);
  });

  it("a harmless .npmrc, one naming the pinned registry, and a plain pnpm-workspace.yaml pass the pre-check", async () => {
    fakeManager("pnpm");
    put("pnpm-lock.yaml", PNPM_LOCK);
    put(".npmrc", "registry=https://registry.npmjs.org/\nauto-install-peers=true\n");
    put("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    expect(await installer().run()).toEqual({ kind: "installed" });
  });

  it("an in-repo workspace project is installed through its real directory", async () => {
    fakeManager("pnpm");
    mkdirSync(path.join(workspace, "packages", "a"), { recursive: true });
    put("pnpm-lock.yaml", PNPM_LOCK.replace("importers:\n", "importers:\n\n  packages/a:\n    dependencies: {}\n"));
    expect(await installer().run()).toEqual({ kind: "installed" });
  });
});

describe("a hostile repo is refused before any package manager starts", () => {
  async function refused(setup: () => void, reason: string): Promise<void> {
    fakeManager("pnpm");
    fakeManager("npm");
    setup();
    const r = installer();
    expect(await r.run()).toEqual({ kind: "refused", reason });
    expect(r.calls, "no package manager started").toEqual([]);
    expect(existsSync(record), "no program ran").toBe(false);
    expect(r.said).toEqual([`fx-runner: dependency install refused (deps_lockfile_refused: ${reason})`]);
  }

  it("a tarball on another host", async () => {
    await refused(() => put("pnpm-lock.yaml", PNPM_LOCK.replace(`{integrity: ${SHA}}`, `{integrity: ${SHA}, tarball: https://evil.example/left-pad.tgz}`)), "other_host_tarball");
  });
  it("an npm lock with a tarball on another host", async () => {
    await refused(() => put("package-lock.json", NPM_LOCK.replace("registry.npmjs.org", "evil.example")), "other_host_tarball");
  });
  it("a git dependency", async () => {
    await refused(() => put("pnpm-lock.yaml", PNPM_LOCK.replace("version: 1.3.0\n\npackages", "version: git+https://github.com/a/b.git#abc\n\npackages")), "unsafe_dependency");
    await refused(() => put("pnpm-lock.yaml", PNPM_LOCK.replace(`{integrity: ${SHA}}`, "{commit: abc, repo: https://github.com/a/b.git, type: git}")), "unsafe_dependency");
  });
  it("a file, link-out-of-repo or missing-integrity dependency", async () => {
    await refused(() => put("pnpm-lock.yaml", PNPM_LOCK.replace("version: 1.3.0\n\npackages", "version: file:../x.tgz\n\npackages")), "unsafe_dependency");
    await refused(() => put("pnpm-lock.yaml", PNPM_LOCK.replace("version: 1.3.0\n\npackages", "version: link:../../outside\n\npackages")), "unsafe_dependency");
    await refused(() => put("pnpm-lock.yaml", PNPM_LOCK.replace(`{integrity: ${SHA}}`, "{tarball: https://registry.npmjs.org/left-pad.tgz}")), "integrity_missing");
  });
  it("a symlinked lockfile is not followed", async () => {
    await refused(() => {
      writeFileSync(path.join(root, "elsewhere.yaml"), PNPM_LOCK);
      symlinkSync(path.join(root, "elsewhere.yaml"), path.join(workspace, "pnpm-lock.yaml"));
    }, "lockfile_not_regular");
  });
  it("a lockfile that is a directory", async () => {
    await refused(() => mkdirSync(path.join(workspace, "pnpm-lock.yaml")), "lockfile_not_regular");
  });
  it("an oversized lockfile is not read", async () => {
    await refused(() => {
      put("pnpm-lock.yaml", "x");
      truncateSync(path.join(workspace, "pnpm-lock.yaml"), 21 * 1024 * 1024);
    }, "lockfile_too_big");
  });
  it("a .npmrc that tries to change the registry, add auth or turn scripts on", async () => {
    for (const rc of ["registry=https://evil.example/\n", "@scope:registry=https://evil.example/\n", "//registry.npmjs.org/:_authToken=abc\n", "ignore-scripts=false\n", "script-shell=/tmp/x\n"]) {
      rmSync(path.join(workspace, ".npmrc"), { force: true });
      await refused(() => {
        put("pnpm-lock.yaml", PNPM_LOCK);
        put(".npmrc", rc);
      }, "npmrc_unsafe");
      rmSync(record, { force: true });
    }
  });
  it("a .npmrc that is a symlink, and a pnpm-workspace.yaml with a registry or a hook", async () => {
    await refused(() => {
      put("pnpm-lock.yaml", PNPM_LOCK);
      writeFileSync(path.join(root, "rc"), "auto-install-peers=true\n");
      symlinkSync(path.join(root, "rc"), path.join(workspace, ".npmrc"));
    }, "npmrc_unsafe");
    rmSync(path.join(workspace, ".npmrc"));
    await refused(() => put("pnpm-workspace.yaml", "packages:\n  - a\nregistry: https://evil.example/\n"), "npmrc_unsafe");
  });
  it("a node_modules that is a link is refused and its target is untouched", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    await refused(() => {
      put("pnpm-lock.yaml", PNPM_LOCK);
      symlinkSync(outside, path.join(workspace, "node_modules"));
    }, "node_modules_link");
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(lstatSync(path.join(workspace, "node_modules")).isSymbolicLink()).toBe(true);
  });
  it("a nested node_modules link is refused too", async () => {
    mkdirSync(path.join(workspace, "packages", "a"), { recursive: true });
    await refused(() => {
      put("pnpm-lock.yaml", PNPM_LOCK);
      symlinkSync(root, path.join(workspace, "packages", "a", "node_modules"));
    }, "node_modules_link");
  });
  it("a project directory that is a link out of the repo is refused and its target is untouched", async () => {
    const outside = path.join(root, "outside-project");
    mkdirSync(outside);
    await refused(() => {
      mkdirSync(path.join(workspace, "packages"));
      symlinkSync(outside, path.join(workspace, "packages", "a"));
      put("pnpm-lock.yaml", PNPM_LOCK.replace("importers:\n", "importers:\n\n  packages/a:\n    dependencies: {}\n"));
    }, "workspace_unsafe");
    expect(existsSync(path.join(outside, "node_modules"))).toBe(false);
  });
});

describe("regression: the forms the security review used against a line scanner are refused before pnpm starts", () => {
  async function refusedFor(files: Record<string, string>, reason: string): Promise<void> {
    fakeManager("pnpm");
    for (const [name, text] of Object.entries(files)) put(name, text);
    const r = installer();
    expect(await r.run()).toEqual({ kind: "refused", reason });
    expect(r.calls).toEqual([]);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(path.join(workspace, "node_modules"))).toBe(false);
  }
  const lockWith = (importers: string, packages: string): string => `lockfileVersion: '9.0'\n\nimporters:\n\n${importers}\npackages:\n\n${packages}\nsnapshots:\n\n  left-pad@1.3.0: {}\n`;
  const dep = "  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n";

  it("an indented lockfile", async () => {
    await refusedFor({ "pnpm-lock.yaml": `root:\n${PNPM_LOCK.replace("{integrity", "{tarball: https://evil.invalid/x.tgz, integrity").split("\n").map((l) => (l === "" ? l : `    ${l}`)).join("\n")}` }, "lockfile_unparsable");
  });
  it("a flow-map packages: with a tarball on another host", async () => {
    await refusedFor({ "pnpm-lock.yaml": `lockfileVersion: '9.0'\nimporters: {".": {dependencies: {left-pad: {specifier: ^1.3.0, version: 1.3.0}}}}\npackages: {left-pad@1.3.0: {resolution: {integrity: ${SHA}, tarball: "https://evil.invalid/left-pad.tgz"}}}\n` }, "other_host_tarball");
  });
  it("a link: on a continuation line and in a folded scalar", async () => {
    await refusedFor({ "pnpm-lock.yaml": lockWith("  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: link:\n          ../../outside\n", `  left-pad@1.3.0:\n    resolution: {integrity: ${SHA}}\n`) }, "lockfile_unparsable");
    await refusedFor({ "pnpm-lock.yaml": lockWith("  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.3.0\n        version: >-\n          link:../../outside\n", `  left-pad@1.3.0:\n    resolution: {integrity: ${SHA}}\n`) }, "unsafe_dependency");
  });
  it("an indented root and an explicit --- flow map in pnpm-workspace.yaml (the virtual store moved out of the workspace)", async () => {
    await refusedFor({ "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": "  virtualStoreDir: /abs\n" }, "npmrc_unsafe");
    rmSync(record, { force: true });
    await refusedFor({ "pnpm-lock.yaml": PNPM_LOCK, "pnpm-workspace.yaml": "--- {virtualStoreDir: /abs}\n" }, "npmrc_unsafe");
    void dep;
  });

  it("a corepack shim with a packageManager field is refused; the same shim without one runs, with corepack's network and strict switches off", async () => {
    writeFileSync(path.join(bin, "corepack"), `#!/bin/sh\n{ echo "ARGS:$*"; echo "ENV-BEGIN"; env; } > '${record}'\nmkdir -p node_modules/.bin\n`);
    chmodSync(path.join(bin, "corepack"), 0o755);
    symlinkSync("corepack", path.join(bin, "pnpm"));
    put("pnpm-lock.yaml", PNPM_LOCK);
    put("package.json", JSON.stringify({ name: "x", packageManager: "pnpm@0.0.1+sha512.deadbeef" }));
    const r = installer();
    expect(await r.run()).toEqual({ kind: "refused", reason: "corepack_shim" });
    expect(r.calls).toEqual([]);
    expect(existsSync(path.join(workspace, "node_modules", ".fx-install"))).toBe(false);
    put("package.json", JSON.stringify({ name: "x" }));
    expect(await installer().run()).toEqual({ kind: "installed" });
    const env = envOfRecord();
    expect(env.COREPACK_ENABLE_NETWORK).toBe("0");
    expect(env.COREPACK_ENABLE_STRICT).toBe("0");
    expect(env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS).toBe("0");
    expect(env.COREPACK_ENABLE_AUTO_PIN).toBe("0");
  });

  it("the command line pins the registry, store, cache, virtual store and modules directory", () => {
    const args = pnpmArgs({ registry: "https://registry.npmjs.org/", storeDir: "/s", cacheDir: "/c" });
    for (const pinned of ["--registry=https://registry.npmjs.org/", "--config.store-dir=/s", "--config.cache-dir=/c", "--config.virtual-store-dir=node_modules/.pnpm", "--config.modules-dir=node_modules", "--ignore-scripts", "--ignore-pnpmfile", "--frozen-lockfile"]) expect(args).toContain(pinned);
  });

  const realPnpm = (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir !== "" && existsSync(path.join(dir, "pnpm")));
  it.skipIf(!realPnpm)("real pnpm: with a workspace file that moves the virtual store and modules directory out of the workspace, the pinned flags win and nothing is written outside (offline)", async () => {
    vi.unstubAllEnvs();
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    mkdirSync(path.join(workspace, "packages", "a"), { recursive: true });
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "root", version: "1.0.0", dependencies: { a: "workspace:*" } }));
    writeFileSync(path.join(workspace, "packages", "a", "package.json"), JSON.stringify({ name: "a", version: "1.0.0" }));
    writeFileSync(path.join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: workspace:*\n        version: link:packages/a\n\n  packages/a: {}\n");
    // Without the pinned flags this very workspace file makes pnpm write its virtual store and `node_modules` under `outside` (checked by hand against pnpm 11.27).
    writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), `packages: ['.', 'packages/*']\nvirtualStoreDir: ${outside}/vs\nmodulesDir: ${outside}/modules\nstoreDir: ${outside}/store\nregistry: https://evil.invalid/\n`);
    const store = path.join(root, "state", "store");
    mkdirSync(store, { recursive: true });
    const env = { PATH: process.env.PATH ?? "", HOME: path.join(root, "home"), TMPDIR: root, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_STRICT: "0" };
    mkdirSync(env.HOME);
    const out = await runInstall(spawn, "pnpm", pnpmArgs({ registry: "https://registry.invalid/", storeDir: store, cacheDir: path.join(workspace, "node_modules", ".pnpm-cache") }), env, workspace, 120_000, 2000);
    expect(out.code, out.tail).toBe(0);
    expect(readdirSync(outside), "nothing written outside the workspace").toEqual([]);
    expect(existsSync(path.join(workspace, "node_modules"))).toBe(true);
  });
});

describe("what is in the workspace first", () => {
  it("an existing node_modules (a committed one, or an earlier round's) is removed without following a link inside it", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    fakeManager("pnpm");
    put("pnpm-lock.yaml", PNPM_LOCK);
    mkdirSync(path.join(workspace, "node_modules", ".pnpm-store"), { recursive: true });
    symlinkSync(outside, path.join(workspace, "node_modules", "evil"));
    writeFileSync(path.join(workspace, "node_modules", "stale.txt"), "stale");
    mkdirSync(path.join(workspace, "packages", "a", "node_modules"), { recursive: true });
    writeFileSync(path.join(workspace, "packages", "a", "node_modules", "stale.txt"), "stale");
    expect(await installer().run()).toEqual({ kind: "installed" });
    expect(existsSync(path.join(workspace, "node_modules", "stale.txt"))).toBe(false);
    expect(existsSync(path.join(workspace, "node_modules", "evil"))).toBe(false);
    expect(existsSync(path.join(workspace, "packages", "a", "node_modules"))).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("the .git directory is not walked", async () => {
    fakeManager("pnpm");
    put("pnpm-lock.yaml", PNPM_LOCK);
    mkdirSync(path.join(workspace, ".git", "node_modules"), { recursive: true });
    expect(await installer().run()).toEqual({ kind: "installed" });
    expect(existsSync(path.join(workspace, ".git", "node_modules"))).toBe(true);
  });
});

describe("failures never throw and never leave a process behind", () => {
  it("a non-zero exit is deps_install_failed with a redacted, capped tail on the terminal only", async () => {
    fakeManager("pnpm", `echo "ERR_PNPM_FETCH_404 token ghp_secretsecretsecretsecretsecretsecret1 in ${workspace}/x"; i=0; while [ $i -lt 400 ]; do echo "padding line $i xxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; exit 3`);
    put("pnpm-lock.yaml", PNPM_LOCK);
    const r = installer();
    expect(await r.run()).toEqual({ kind: "failed", why: "exit" });
    expect(r.said).toHaveLength(1);
    expect(r.said[0]).toMatch(/^fx-runner: dependency install failed \(deps_install_failed: exit, exit 3\)/);
    expect(r.said[0]!.length).toBeLessThan(700);
    expect(r.said[0]).not.toContain("ghp_");
    expect(existsSync(path.join(workspace, "node_modules", ".fx-install"))).toBe(false);
  });

  it("the secret in the tail is redacted", async () => {
    fakeManager("pnpm", `echo "auth ghp_secretsecretsecretsecretsecretsecret1 in ${workspace}/x"; exit 1`);
    put("pnpm-lock.yaml", PNPM_LOCK);
    const r = installer();
    expect(await r.run()).toEqual({ kind: "failed", why: "exit" });
    expect(r.said[0]).not.toContain("ghp_secret");
    expect(r.said[0]).toContain("<workspace>/x");
    expect(r.said[0]).not.toContain(workspace);
  });

  it("the time limit ends the whole process group, including what the install started", async () => {
    const pidFile = path.join(root, "grandchild.pid");
    fakeManager("pnpm", `sleep 60 &\necho $! > '${pidFile}'\nwait`);
    put("pnpm-lock.yaml", PNPM_LOCK);
    const r = installer({ timeoutMs: 400 });
    const started = Date.now();
    expect(await r.run()).toEqual({ kind: "failed", why: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive, "the grandchild is gone").toBe(false);
    expect(r.said[0]).toContain("deps_install_failed: timeout");
  });

  it("a stop signal ends the install the same way", async () => {
    fakeManager("pnpm", "sleep 60");
    put("pnpm-lock.yaml", PNPM_LOCK);
    const stop = new AbortController();
    const r = installer();
    const pending = r.run(stop.signal);
    setTimeout(() => stop.abort(), 200);
    expect(await pending).toEqual({ kind: "failed", why: "aborted" });
    expect(await installer().run(AbortSignal.abort())).toEqual({ kind: "failed", why: "aborted" });
  });

  it("a package manager that is not installed is deps_install_failed, not a crash", async () => {
    vi.stubEnv("PATH", path.join(root, "nowhere"));
    put("pnpm-lock.yaml", PNPM_LOCK);
    const said: string[] = [];
    const subject = createDepsInstaller({ capture: async () => { throw new Error("must not be called"); }, envOptions: { extraPathDirs: [path.join(root, "empty-bin")] }, say: (line) => said.push(line) });
    expect(await subject.run({ workspace, registryHost: HOST, storeDir: STORE })).toEqual({ kind: "failed", why: "tool_missing" });
    expect(said).toEqual(["fx-runner: dependency install did not run (deps_install_failed: pnpm not found)"]);
    expect(existsSync(path.join(workspace, "node_modules", ".fx-install"))).toBe(false);
  });
});
