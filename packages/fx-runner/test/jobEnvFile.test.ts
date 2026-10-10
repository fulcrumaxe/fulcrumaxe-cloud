import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanEnv, type CleanEnvOptions } from "../src/job/cleanEnv.js";
import { HostSandboxRefused, createHostSandbox } from "../src/sandbox/hostSandbox.js";
import { JOB_ENV_FILE_NAME, JobEnvFileRefused, jobEnvFileText, writeJobEnvFile } from "../src/sandbox/jobEnvFile.js";
import { runJob, createMemoryLedger } from "../src/job/runJob.js";
import { createWorkspaceStore } from "../src/job/workspace.js";
import { bwrapArgs } from "../src/sandbox/probe.js";
import { sandboxToolDirs } from "../src/sandbox/select.js";
import { bwrapCanCreateNamespaces } from "./helpers/bwrapProbe.js";
import { findOnPath } from "./helpers/findOnPath.js";
import { sampleJob } from "./helpers/sampleJob.js";
import { tmpRoot } from "./helpers/tmpRoot.js";

/**
 * D#6 C44-1: the per-job env file (`CLAUDE_ENV_FILE`) and TMPDIR for every job.
 *
 * Every shell here runs in a throwaway HOME made with mkdtemp. Nothing reads or writes the real home directory (its own rc file carries a hotfix that would hide the bug).
 */
const dirs: string[] = [];
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpRoot(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("C44-1: the file's text", () => {
  it("is one single-quoted export line per name", () => {
    expect(jobEnvFileText({ PATH: "/a/bin:/b/bin", TMPDIR: "/t/x y" })).toBe("export PATH='/a/bin:/b/bin'\nexport TMPDIR='/t/x y'\n");
  });
  it.each([
    ["a single quote", "/a/it's"],
    ["a newline", "/a\n/b"],
    ["a NUL", "/a\0/b"],
    ["a carriage return", "/a\r/b"],
    ["an empty value", ""],
  ])("refuses a value with %s", (_label, value) => {
    expect(() => jobEnvFileText({ PATH: value })).toThrow(JobEnvFileRefused);
  });
  it("refuses a name that is not a plain identifier", () => {
    expect(() => jobEnvFileText({ "PATH;x": "/a" })).toThrow(JobEnvFileRefused);
  });
});

describe("C44-1: writing it", () => {
  it("makes a 0600 file in the temp dir, and a refused value leaves nothing on disk", () => {
    const dir = scratchDir("c441-w-");
    const file = writeJobEnvFile(dir, { PATH: "/a", TMPDIR: dir });
    expect(file).toBe(path.join(dir, JOB_ENV_FILE_NAME));
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("export PATH='/a'");
    const other = scratchDir("c441-w2-");
    expect(() => writeJobEnvFile(other, { PATH: "/it's" })).toThrow(JobEnvFileRefused);
    expect(readdirSync(other)).toEqual([]);
  });

  it("replaces an earlier file (a resumed run) and never writes through a link planted at the path", () => {
    const dir = scratchDir("c441-l-");
    const victim = path.join(scratchDir("c441-v-"), "victim");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, path.join(dir, JOB_ENV_FILE_NAME));
    const file = writeJobEnvFile(dir, { PATH: "/a" });
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("export PATH='/a'\n");
    writeJobEnvFile(dir, { PATH: "/b" });
    expect(readFileSync(file, "utf8")).toBe("export PATH='/b'\n");
  });

  it("a directory that does not exist is the closed refusal, not a raw ENOENT", () => {
    expect(() => writeJobEnvFile(path.join(scratchDir("c441-m-"), "missing"), { PATH: "/a" })).toThrow(JobEnvFileRefused);
  });

  it("refuses a temp dir that is a link, or not absolute", () => {
    const real = scratchDir("c441-r-");
    const link = path.join(scratchDir("c441-k-"), "link");
    symlinkSync(real, link);
    expect(() => writeJobEnvFile(link, { PATH: "/a" })).toThrow(JobEnvFileRefused);
    expect(() => writeJobEnvFile("relative/dir", { PATH: "/a" })).toThrow(JobEnvFileRefused);
    expect(readdirSync(real)).toEqual([]);
  });
});

/** A host sandbox over a throwaway HOME whose runtime records the job env it is given. */
function rig(envOptions: CleanEnvOptions = {}) {
  const root = scratchDir("c441-host-");
  const home = path.join(root, "home");
  const tempRoot = path.join(home, ".cache", "fx-runner", "tmp");
  const workspaceRoot = path.join(home, ".cache", "fx-runner", "workspaces");
  mkdirSync(workspaceRoot, { recursive: true });
  const jobEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
  const blocks: Array<Record<string, unknown>> = [];
  const host = createHostSandbox({
    credentials: { mode: "subscription" },
    envOptions,
    home,
    stateDir: path.join(home, ".fx-runner"),
    binaryDir: path.join(root, "bin"),
    tempRoot,
    workspaceRoot,
    makeRuntime: (sandbox, _protected, jobEnv) => {
      blocks.push(sandbox);
      jobEnvs.push(jobEnv);
      return { start: async (opts) => ({ handle: { runId: opts.runId, done: Promise.resolve() } }), stop: async () => undefined, resume: async (handle) => ({ handle }) };
    },
  });
  async function launch(name = "rn-1") {
    const workdir = path.join(workspaceRoot, name);
    mkdirSync(workdir);
    const handle = await host.createSandbox({ sandboxName: name, retention: { persistent: false }, timeoutMs: 60_000 });
    const started = host.startDetached(handle, {
      runId: "run", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir, capUsd: 0,
      networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }, envOptions), onEvent: () => undefined,
    });
    await started.launched;
    return { handle, tempDir: path.join(tempRoot, name), envDir: path.join(home, ".fx-runner", "job-env", name), workdir };
  }
  return { host, jobEnvs, blocks, launch, home };
}

describe("C44-1: the host sandbox gives every job TMPDIR and the env file", () => {
  it("a job without allowances gets TMPDIR = its temp dir and a CLAUDE_ENV_FILE in a 0700 runner-owned dir under the state dir (not the workspace, not the temp dir); both go with the sandbox", async () => {
    const r = rig();
    const { handle, tempDir, envDir, workdir } = await r.launch();
    expect(r.jobEnvs[0]).toEqual({ TMPDIR: tempDir, CLAUDE_ENV_FILE: path.join(envDir, JOB_ENV_FILE_NAME) });
    expect(readdirSync(workdir)).toEqual([]);
    expect(readdirSync(tempDir)).toEqual([]);
    expect(lstatSync(envDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(envDir, JOB_ENV_FILE_NAME)).mode & 0o777).toBe(0o600);
    await r.host.deleteSandbox(handle);
    expect(existsSync(tempDir)).toBe(false);
    expect(existsSync(envDir)).toBe(false);
  });

  it("the file holds the PATH the engine is given, including the runner's extra directories", async () => {
    const extra = scratchDir("c441-tool-");
    const r = rig({ extraPathDirs: [extra] });
    const { tempDir, envDir } = await r.launch();
    const engineEnv = cleanEnv({ mode: "subscription" }, { extraPathDirs: [extra], jobEnv: r.jobEnvs[0]! });
    expect(engineEnv.TMPDIR).toBe(tempDir);
    expect(engineEnv.CLAUDE_ENV_FILE).toBe(path.join(envDir, JOB_ENV_FILE_NAME));
    expect(readFileSync(path.join(envDir, JOB_ENV_FILE_NAME), "utf8")).toBe(`export PATH='${engineEnv.PATH}'\nexport TMPDIR='${tempDir}'\n`);
    expect(engineEnv.PATH).toContain(extra);
  });

  it("keeps the sandbox tool directories (bwrap, socat) from resolveSandboxTools' result in the file's PATH", async () => {
    const bwrapDir = scratchDir("c441-bwrap-");
    const socatDir = scratchDir("c441-socat-");
    const dirs = sandboxToolDirs({ bwrap: path.join(bwrapDir, "bwrap"), socat: path.join(socatDir, "socat") });
    const r = rig({ extraPathDirs: dirs });
    const { envDir } = await r.launch();
    const text = readFileSync(path.join(envDir, JOB_ENV_FILE_NAME), "utf8");
    const filePath = /^export PATH='(.*)'$/m.exec(text)![1]!.split(":");
    expect(filePath).toEqual(expect.arrayContaining([bwrapDir, socatDir]));
  });

  it.each([
    ["a single quote", "/opt/it's/bin"],
    ["a newline", "/opt/a\nb/bin"],
  ])("a PATH entry with %s refuses the job with a closed reason, writes no file and builds no runtime", async (_label, entry) => {
    const r = rig({ extraPathDirs: [entry] });
    const handle = await r.host.createSandbox({ sandboxName: "rn-bad", retention: { persistent: false }, timeoutMs: 60_000 });
    const workdir = path.join(r.home, ".cache", "fx-runner", "workspaces", "bad");
    mkdirSync(workdir);
    const attempt = (): unknown =>
      r.host.startDetached(handle, {
        runId: "run", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir, capUsd: 0,
        networkPolicy: [{ host: "api.anthropic.com", purpose: "model" }], env: cleanEnv({ mode: "subscription" }, { extraPathDirs: [entry] }), onEvent: () => undefined,
      });
    expect(attempt).toThrow(HostSandboxRefused);
    try {
      attempt();
    } catch (error) {
      expect((error as HostSandboxRefused).code).toBe("job_env_unsafe");
      expect((error as Error).message).not.toContain("opt");
    }
    expect(r.jobEnvs).toEqual([]);
    expect(readdirSync(path.join(r.home, ".cache", "fx-runner", "tmp", "rn-bad"))).toEqual([]);
    expect(existsSync(path.join(r.home, ".fx-runner", "job-env", "rn-bad", JOB_ENV_FILE_NAME))).toBe(false);
  });

  it("through runJob the refusal is the failed reason job_env_unsafe", async () => {
    const r = rig({ extraPathDirs: ["/opt/it's/bin"] });
    const store = createWorkspaceStore(path.join(r.home, ".cache", "fx-runner", "workspaces"));
    const out = await runJob(
      { ...sampleJob(), job_id: "44444444-4444-4444-8444-444444444444", run_id: "c0ffee00-0000-4000-8000-0000000c4410", continues: null, model_hint: null },
      { sandbox: r.host, workspaces: store, ledger: createMemoryLedger(), credentials: { mode: "subscription" }, envOptions: { extraPathDirs: ["/opt/it's/bin"] }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" },
    );
    expect(out).toMatchObject({ status: "failed", reason: "job_env_unsafe" });
  });
});

const bash = findOnPath("bash", process.env.PATH ?? "");

describe.skipIf(bash === undefined)("C44-1 criterion 1: a start-up file that resets PATH, in a throwaway HOME, with the real bash -l", () => {
  /** A HOME whose `.profile` and `.bashrc` unset the NixOS marker, source /etc/profile when it exists, then reset PATH to an empty directory. */
  function fakeHome(): string {
    const home = scratchDir("c441-home-");
    mkdirSync(path.join(home, "default-bin"));
    const rc = ['unset __NIXOS_SET_ENVIRONMENT_DONE', '[ -r /etc/profile ] && . /etc/profile', 'PATH="$HOME/default-bin"', 'export PATH', ""].join("\n");
    writeFileSync(path.join(home, ".bashrc"), rc);
    writeFileSync(path.join(home, ".profile"), '. "$HOME/.bashrc"\n');
    return home;
  }
  /** A toolchain directory with a `node` and a `pnpm` that only the runner's extra directories can reach. */
  function toolchain(): string {
    const dir = scratchDir("c441-toolchain-");
    for (const name of ["node", "pnpm"]) {
      const file = path.join(dir, name);
      writeFileSync(file, `#!/bin/sh\necho ${name}-fake\n`);
      chmodSync(file, 0o755);
    }
    return dir;
  }
  const PROBE = 'command -v node; command -v pnpm; echo "TMPDIR=$TMPDIR"';
  const shell = (home: string, env: Record<string, string>, command: string) =>
    spawnSync(bash!, ["-l", "-c", command], { env: { ...env, HOME: home }, encoding: "utf8", timeout: 30_000 });

  it("finds node and pnpm and prints the job temp dir once the env file is sourced; the control without it loses both", async () => {
    const home = fakeHome();
    vi.stubEnv("HOME", home);
    const tools = toolchain();
    const r = rig({ extraPathDirs: [tools] });
    const { tempDir } = await r.launch();
    const env = cleanEnv({ mode: "subscription" }, { extraPathDirs: [tools], jobEnv: r.jobEnvs[0]! });
    expect(env.PATH).toContain(tools);

    // The control: the same shell, same environment, env file not sourced. The rc file reset PATH, so the toolchain is gone.
    const control = shell(home, env, PROBE);
    expect(control.status).toBe(0);
    expect(control.stdout).not.toMatch(/\/node$/m);
    expect(control.stdout).not.toMatch(/\/pnpm$/m);

    // What the agent CLI does: source the named file after the login shell started.
    const withFile = shell(home, env, `. "$CLAUDE_ENV_FILE"; ${PROBE}`);
    expect(withFile.status, withFile.stderr).toBe(0);
    expect(withFile.stdout).toMatch(/^\/.*\/node$/m);
    expect(withFile.stdout).toMatch(/^\/.*\/pnpm$/m);
    expect(withFile.stdout).toContain(`TMPDIR=${tempDir}\n`);
  });
});

const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const bwrapUsable = BWRAP !== undefined && bwrapCanCreateNamespaces(BWRAP);

describe.skipIf(!bwrapUsable)("C44-1 (security): from inside the real sandbox the job cannot touch the env file the CLI reads on the host", () => {
  it("rm, ln -sf, mv onto the path and a > redirect all leave the host file unchanged; the path is not even visible; the job's own temp dir stays writable", async () => {
    const r = rig();
    const { tempDir, envDir } = await r.launch();
    const file = path.join(envDir, JOB_ENV_FILE_NAME);
    const before = readFileSync(file, "utf8");
    const settings = r.blocks[0]!;
    const inSandbox = (script: string) =>
      spawnSync(BWRAP!, [...bwrapArgs(settings, (target) => existsSync(target) && statSync(target).isDirectory(), (target) => existsSync(target) && statSync(target).isFile()), "--", "/bin/sh", "-c", script], {
        env: { PATH: "/run/current-system/sw/bin:/usr/bin:/bin", HOME: r.home, TMPDIR: tempDir },
        encoding: "utf8",
        timeout: 20_000,
      });
    // control: the sandbox runs and the job's own temp dir is writable
    expect(inSandbox(`echo ok > ${tempDir}/mine && cat ${tempDir}/mine`).stdout.trim()).toBe("ok");
    // the file and its directory are not visible, and cannot be read
    expect(inSandbox(`test -e ${file}`).status).not.toBe(0);
    expect(inSandbox(`cat ${file}`).stdout).toBe("");
    const attacks = [`rm -f ${file}`, `ln -sf /etc/hostname ${file}`, `echo x > ${tempDir}/other && mv ${tempDir}/other ${file}`, `echo pwned > ${file}`, `rm -rf ${envDir}`, `mv ${envDir} ${tempDir}/moved`];
    for (const attack of attacks) {
      inSandbox(attack);
      expect(lstatSync(file).isSymbolicLink(), attack).toBe(false);
      expect(readFileSync(file, "utf8"), attack).toBe(before);
    }
    for (const attack of attacks.filter((a) => !a.startsWith("rm -f") && !a.startsWith("rm -rf"))) expect(inSandbox(attack).status, attack).not.toBe(0);
  });
});
