import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InstallCapture } from "../../src/daemon/engineKit.js";
import type { GitCapture } from "../../src/daemon/git.js";
import { createMachineJobDispatcher } from "../../src/daemon/machineJobs.js";
import { buildWorkspaceArchive } from "../../src/daemon/vmArchive.js";
import { engineHostUnit } from "../../src/engineHost/supervisor.js";
import { runInstall } from "../../src/engines/claude/capture.js";
import { createEngineSessionHandlers } from "../../src/engineSession/lifecycle.js";
import { createOperateMark } from "../../src/engineSession/operateMark.js";
import { createStandardSessionParts, onTmpfs, sessionHandlersFor } from "../../src/engineSession/standardTier.js";
import { detectScopeSupport } from "../../src/sandbox/jobLimits.js";
import { createSandboxHost } from "../../src/sandbox/probeHost.js";
import type { HostGuestDeps } from "../../src/setup/hostGuest.js";
import { checkCanLaunch } from "../helpers/bwrapProbe.js";
import { JOB_KEYRING, RUNNER_ID, signedJob } from "../helpers/machineJobFixture.js";
import { fixtureRepo, hostDeps } from "../vm/workspace/helpers.js";
import { NAME, compactSession, del as delOf, start as startOf, stop as stopOf } from "./sessionRig.js";

/**
 * D#845 ON-13a3 with REAL bubblewrap and a REAL systemd user scope: the engine session on the standard tier, driven through the real dispatcher and the real lifecycle handlers. The stand-ins are the least that can be:
 * the repository archive (a fixture repository) and the cloud's reports. Every child runs on a PRIVATE PATH (links to the few programs it needs): the real `claude`, `gh` and git credential helpers are not on it, and the
 * test asserts that before it spawns anything.
 */
const BWRAP = ["/run/current-system/sw/bin/bwrap", "/usr/bin/bwrap", "/bin/bwrap"].find((candidate) => existsSync(candidate));
const XDG = process.env["XDG_RUNTIME_DIR"];
const run: GitCapture = (command, args, env) =>
  new Promise((resolve) => execFile(command, [...args], { env, timeout: 10_000 }, (error, stdout) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, timedOut: false })));
const SCOPES = XDG === undefined ? undefined : await detectScopeSupport({ platform: "linux", uid: process.getuid?.(), runtimeDir: XDG, searchPath: "/run/current-system/sw/bin:/usr/bin:/bin", capture: run, isDir: (d) => existsSync(d), readText: (f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined) });
const tools = SCOPES?.ok === true ? SCOPES.tools : undefined;
const usable = BWRAP !== undefined && checkCanLaunch(BWRAP) && tools !== undefined && XDG !== undefined && onTmpfs(XDG);

const SENTINEL = "FX-ON13A3-SENTINEL";
const PROGRAMS = ["sh", "env", "base64", "tar", "gzip", "git", "readlink", "cat", "sleep", "true", "mkdir", "rm", "chmod", "ls", "head", "grep", "bwrap", "socat"];
/** The jobs a standard-tier machine is sent: the kinds do not need a microVM. */
const ANY = { requires_engine: "any" };
const start = (sha: string, resume: boolean) => startOf(sha, resume, 1, ANY);
const stop = () => stopOf(1, "person", ANY);
const del = () => delOf(1, ANY);
let base: string;
let home: string;
let stateDir: string;
let bundle: string;
let privateBin: string;
const spawnIn: InstallCapture = (command, args, env, cwd, timeoutMs, tailChars, signal, feed, onLine, onData) => runInstall(spawn, command, args, env, cwd, timeoutMs, tailChars, signal, feed, onLine, onData);

beforeAll(() => {
  if (!usable) return;
  base = mkdtempSync(path.join(realpathSync(homedir()), ".fxes-"));
  home = path.join(base, "home");
  stateDir = path.join(base, "state"); // beside the home directory, not in it: the state directory's own rule is what is tested
  privateBin = path.join(base, "private-bin");
  for (const dir of [stateDir, privateBin, path.join(base, "claude-bin"), path.join(base, "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(stateDir, "key.pem"), SENTINEL);
  const hostPath = `${process.env["PATH"] ?? ""}:/run/current-system/sw/bin:/usr/bin:/bin`.split(path.delimiter);
  for (const name of PROGRAMS) {
    const found = hostPath.map((dir) => path.join(dir, name)).find((candidate) => existsSync(candidate));
    if (found !== undefined) symlinkSync(realpathSync(found), path.join(privateBin, name));
  }
  bundle = path.join(base, "bin", "fx-runner.cjs");
  buildSync({ entryPoints: [path.join(__dirname, "..", "..", "bin", "fx-runner.mjs")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: bundle, logLevel: "silent", define: { "import.meta.url": JSON.stringify(pathToFileURL(bundle).href), __FX_BUILD_EPOCH__: '"0"' } });
}, 60_000);
afterAll(() => {
  if (usable) rmSync(base, { recursive: true, force: true });
});

function world(options: { xdg?: string | undefined; isTmpfs?: (dir: string) => boolean } = {}) {
  // the runner's layout: `<cache>/engine-sessions/roots`, the cache directory two levels up
  const cacheDir = path.join(base, "sessions", `r${String(Math.random()).slice(2, 8)}`);
  const jobsRoot = path.join(cacheDir, "engine-sessions", "roots");
  mkdirSync(path.dirname(jobsRoot), { recursive: true, mode: 0o700 });
  const guest: HostGuestDeps = {
    start: spawnIn, host: createSandboxHost(async () => ({ code: null, stdout: "", stderr: "", timedOut: false })), platform: "linux", home, stateDir, binaryDir: path.join(base, "claude-bin"), jobsRoot, cacheDir, searchPath: privateBin,
    selfCommand: [process.execPath, bundle], uid: process.getuid?.(), scope: { tools: tools as NonNullable<typeof tools>, runtimeDir: XDG as string, budget: { memoryBytes: 2 * 1024 ** 3, tasks: 256 } },
  };
  const parts = createStandardSessionParts({ guest, xdgRuntimeDir: "xdg" in options ? options.xdg : XDG, capture: run, ...(options.isTmpfs === undefined ? {} : { isTmpfs: options.isTmpfs }) });
  const repo = fixtureRepo();
  const host = hostDeps();
  const reports: Array<Record<string, unknown> & { job_id: string }> = [];
  const handlers = createEngineSessionHandlers({
    vm: parts.vm, port: () => parts.port, state: parts.state, wipeToken: parts.wipeToken, minGuestMb: 1,
    get paths() {
      return parts.paths();
    },
    repos: { async open({ baseSha }) { return { mirrorDir: repo.mirror, workspace: "/srv/unused", archive: await buildWorkspaceArchive(host, repo.mirror, baseSha), release: async () => undefined }; } },
    repoOf: async () => ({ owner: "acme", name: "widgets" }),
    mark: createOperateMark({ stateDir: path.join(base, `mark${String(Math.random()).slice(2, 8)}`), uid: process.getuid?.() as number, log: () => undefined }),
    runnerId: RUNNER_ID,
  });
  async function go(...list: Parameters<typeof signedJob>[0][]): Promise<void> {
    const claims = list.map((job) => ({ kind: "job" as const, signedJob: signedJob(job) }));
    const client = {
      machineJobClaim: async () => claims.shift() ?? { kind: "none" as const, retryAfter: 60 },
      setupProgress: async (): Promise<never> => {
        throw new Error("no setup");
      },
      machineJobProgress: async (id: string, body: unknown) => (reports.push({ ...(body as object), job_id: id }), { kind: "recorded" as const }),
    };
    const dispatcher = createMachineJobDispatcher({ client, keyring: JOB_KEYRING, runnerId: RUNNER_ID, now: () => new Date(), handlers: sessionHandlersFor({ microvm: undefined, standard: handlers }, () => "os_sandbox") ?? {}, sandboxEngine: () => "os_sandbox", log: () => undefined });
    for (let i = 0; i < list.length; i++) expect(await dispatcher.run()).toBe("handled");
  }
  return { parts, repo, go, last: (): string[] => compactSession(reports.splice(0)), jobsRoot };
}

/** The scope's `cgroup.procs` pids, or [] once the scope is gone. */
async function procsOf(unit: string): Promise<number[]> {
  const shown = await run((tools as NonNullable<typeof tools>).systemctl, ["--user", "show", `${unit}.scope`, "-p", "ControlGroup"], { XDG_RUNTIME_DIR: XDG as string }, 5_000);
  const group = /^ControlGroup=(\S+)/m.exec(shown.stdout)?.[1];
  const file = group === undefined ? undefined : path.join("/sys/fs/cgroup", group, "cgroup.procs");
  return file !== undefined && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => /^\d+$/.test(l)).map(Number) : [];
}
const commandOf = (pid: number): string => path.basename(readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0")[0] as string);
type Held = { logs(): AsyncIterable<{ data: string }>; wait(): Promise<{ exitCode: number }> };

describe.skipIf(!usable)("an engine session on the standard tier (real bubblewrap, real systemd user scope)", () => {
  it("runs on a private PATH: no real claude, gh or credential helper is reachable", () => {
    for (const name of ["claude", "gh", "git-credential-store", "git-credential-cache", "git-credential-manager", "git-credential-libsecret"]) expect(existsSync(path.join(privateBin, name))).toBe(false);
    expect(readdirSync(privateBin).length).toBeGreaterThan(5);
  });

  it("start: one sandboxed idle holder in the session's scope; stop leaves cgroup.procs empty; resume reuses the root, a start with no resume re-seeds it, delete leaves nothing", async () => {
    const w = world();
    const unit = engineHostUnit(77);
    await w.go(start(w.repo.commit, false));
    expect(w.last()).toEqual(["admission:started", "admission:ok", "session_create:started", "session_create:ok", "seed:started", "seed:ok", "session_boot:started", "session_boot:ok", "done:ok@created"]);
    expect(await w.parts.state(NAME)).toBe("running");

    // the scope holds the sandboxed process tree, and one of them is the idle holder
    const before = await procsOf(unit);
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(before.map(commandOf)).toContain("sleep");

    // the token file: 0700 directory, 0600 empty file on the tmpfs, its path in the program's environment, and neither the runtime directory nor the bus in it
    const tokenFile = path.join(XDG as string, "fx-engine-session", NAME, "repo-token");
    expect(lstatSync(path.dirname(tokenFile)).mode & 0o777).toBe(0o700);
    expect(lstatSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenFile, "utf8")).toBe("");
    const holder = before.find((pid) => commandOf(pid) === "sleep") as number;
    const env = readFileSync(`/proc/${String(holder)}/environ`, "utf8").split("\0");
    expect(env).toContain(`FX_ENGINE_REPO_TOKEN_FILE=${tokenFile}`);
    expect(env.some((v) => v.startsWith("XDG_RUNTIME_DIR=") || v.startsWith("DBUS_SESSION_BUS_ADDRESS="))).toBe(false);
    writeFileSync(tokenFile, "FX-TOKEN-CONTENT"); // ON-18 writes it; a stop empties it

    // S-6: from inside the same sandbox the session cannot read the runner's key or see it in the state directory; its own root it can write (control); the key is really there
    const root = path.join(w.jobsRoot, readdirSync(w.jobsRoot)[0] as string);
    const probe = await ((await w.parts.vm.guestOf({ runId: "", sandboxName: NAME, sessionId: "" })) as unknown as { hold(p: unknown): Promise<Held> }).hold({
      cmd: "sh",
      args: ["-c", `cat '${path.join(stateDir, "key.pem")}' >/dev/null 2>&1 && echo KEY_READ || echo KEY_DENIED; ls '${stateDir}' 2>/dev/null | grep -q key.pem && echo KEY_LISTED || echo KEY_HIDDEN; grep -q TOKEN-CONTENT "$FX_ENGINE_REPO_TOKEN_FILE" && echo TOKEN_READABLE; { echo x >> "$FX_ENGINE_REPO_TOKEN_FILE"; } 2>/dev/null && echo TOKEN_WRITABLE || echo TOKEN_READ_ONLY; echo x > '${root}/work/marker' && echo ROOT_WRITABLE`],
      unit: engineHostUnit(4242),
      env: { FX_ENGINE_REPO_TOKEN_FILE: tokenFile },
      readPaths: [path.dirname(tokenFile)],
      limitMs: 30_000,
    });
    let said = "";
    for await (const line of probe.logs()) said += line.data;
    expect((await probe.wait()).exitCode).toBe(0);
    expect(said.split("\n").filter((l) => l !== "")).toEqual(["KEY_DENIED", "KEY_HIDDEN", "TOKEN_READABLE", "TOKEN_READ_ONLY", "ROOT_WRITABLE"]);
    expect(readFileSync(path.join(stateDir, "key.pem"), "utf8")).toBe(SENTINEL);

    // stop: the proxy's directory is removed, the scope is gone, cgroup.procs is empty, and no process of it is alive
    const egress = path.join(path.dirname(w.jobsRoot), "setup-egress", path.basename(root));
    expect(existsSync(egress)).toBe(true);
    await w.go(stop());
    expect(existsSync(egress)).toBe(false);
    expect(readFileSync(tokenFile, "utf8")).toBe(""); // the content is wiped before the stop
    expect(w.last()).toEqual(["admission:started", "admission:ok", "session_stop:started", "session_stop:ok", "snapshot:started", "snapshot:ok", "done:ok"]);
    expect(await w.parts.state(NAME)).toBe("stopped");
    expect(await procsOf(unit)).toEqual([]);
    expect(before.some((pid) => existsSync(`/proc/${String(pid)}`))).toBe(false);

    // resume: the root (and what the session left in it) is reused and a new holder runs; a start with no resume re-seeds it
    await w.go(start(w.repo.commit, true));
    expect(w.last()).toContain("done:ok@resumed");
    expect(existsSync(path.join(root, "work", "marker"))).toBe(true);
    expect((await procsOf(unit)).length).toBeGreaterThanOrEqual(3);
    await w.go(stop(), start(w.repo.commit, false));
    expect(w.last()).toContain("done:ok@created");
    expect(existsSync(path.join(root, "work", "marker"))).toBe(false);
    expect(existsSync(path.join(root, "work", "README.md"))).toBe(true);

    // delete: nothing is left of the session, the scope included
    await w.go(del());
    expect(await w.parts.state(NAME)).toBe("gone");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path.dirname(tokenFile))).toBe(false);
    expect(await procsOf(unit)).toEqual([]);
  }, 120_000);

  it("refuses to start without a tmpfs runtime directory, and leaves nothing running", async () => {
    for (const xdg of [undefined, path.join(base, "not-a-tmpfs")]) {
      if (xdg !== undefined) mkdirSync(xdg, { recursive: true, mode: 0o700 });
      if (xdg !== undefined && onTmpfs(xdg)) continue; // a home directory on tmpfs cannot show the refusal
      const w = world({ xdg });
      await w.go(start(w.repo.commit, false));
      expect(w.last().at(-1)).toBe("session_create:failed:vm_boot_failed");
      expect(await procsOf(engineHostUnit(77))).toEqual([]);
      expect(await w.parts.state(NAME)).toBe("gone");
    }
  }, 60_000);

  it("refuses a runtime directory that is a tmpfs but not this user's own: a shared tmpfs, a sibling of it, a directory that only starts with its name; and one below it that is not a tmpfs", async () => {
    const own = XDG as string;
    const cases: Array<{ xdg: string; isTmpfs?: (dir: string) => boolean }> = [{ xdg: `${own}-other`, isTmpfs: () => true }, { xdg: path.join(path.dirname(own), "0"), isTmpfs: () => true }, { xdg: path.join(own, "sub"), isTmpfs: () => false }];
    if (onTmpfs("/dev/shm")) cases.push({ xdg: "/dev/shm" }); // a real, shared tmpfs: the check is on whose it is, not only on its type
    for (const one of cases) {
      const w = world(one);
      await w.go(start(w.repo.commit, false));
      expect(w.last().at(-1), one.xdg).toBe("session_create:failed:vm_boot_failed");
      expect(await procsOf(engineHostUnit(77))).toEqual([]);
      expect(await w.parts.state(NAME)).toBe("gone");
    }
    // control: this user's own runtime directory, or a directory below it on the tmpfs, is accepted
    const w = world({ xdg: own });
    await w.go(start(w.repo.commit, false));
    expect(w.last().at(-1)).toBe("done:ok@created");
    await w.go(del());
  }, 120_000);

  it("a stop that finds the scope already gone (it ended on its own) still wipes the token file, and says the stop was skipped", async () => {
    const w = world();
    const unit = engineHostUnit(77);
    await w.go(start(w.repo.commit, false));
    w.last();
    const tokenFile = path.join(XDG as string, "fx-engine-session", NAME, "repo-token");
    writeFileSync(tokenFile, "FX-TOKEN-LEFT-BEHIND");
    // the scope dies without a stop job (a crash of the program, or of the user manager's scope)
    await run((tools as NonNullable<typeof tools>).systemctl, ["--user", "kill", "--signal=SIGKILL", `${unit}.scope`], { XDG_RUNTIME_DIR: XDG as string }, 5_000);
    for (let i = 0; i < 100 && (await w.parts.state(NAME)) === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await w.parts.state(NAME)).toBe("stopped");
    expect(readFileSync(tokenFile, "utf8")).toBe("FX-TOKEN-LEFT-BEHIND"); // control: still there before the stop job
    await w.go(stop());
    expect(w.last()).toEqual(["admission:started", "admission:ok", "session_stop:skipped", "snapshot:skipped", "done:ok"]);
    expect(readFileSync(tokenFile, "utf8")).toBe("");
    expect(lstatSync(tokenFile).mode & 0o777).toBe(0o600);
    // a stop of a session that was never kept makes nothing
    await w.go(del());
    await w.go(stop());
    expect(existsSync(path.dirname(tokenFile))).toBe(false);
  }, 120_000);

  it("a resume of a session nothing was kept for takes the fresh start", async () => {
    const w = world();
    await w.go(start(w.repo.commit, true));
    expect(w.last()).toContain("done:ok@fresh");
    await w.go(del());
  }, 60_000);
});
