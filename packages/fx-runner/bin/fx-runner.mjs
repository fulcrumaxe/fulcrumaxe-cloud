#!/usr/bin/env node
// The one place the command line meets the shell: it looks up a few variables by name and hands everything to runCli.
// The environment is never copied, listed or passed on (test/cli/cli.test.ts checks this file). It is also where the real process
// start, the real signal source and this program's own path are handed to `run`, `doctor` and `service`, so that nothing under
// src/ has to name them. The two Anthropic variables reach `doctor` as names only, never as values.
import { execFile, spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli } from "../src/cli.js";
import { RUNNER_VERSION } from "../src/version.js";
import { API_KEY_MAX_BYTES } from "../src/credentials.js";
import { readSecret } from "../src/secretInput.js";
import { VM_TOKEN_MAX, VM_TOKEN_PROMPT, VmTokenError, readVmToken } from "../src/credentials/vmToken.js";
import { askOnTerminal } from "../src/ttyAsk.js";
import { CODE_MAX_BYTES } from "../src/codeSource.js";
import { CliError } from "../src/cliError.js";
import { createClaudeKit } from "../src/engines/claude/kit.js";
import { terminateGroup } from "../src/engines/claude/processGroup.js";
import { resolveClaudePath } from "../src/engines/claude/pin.js";
import { SUBSCRIPTION_TOKEN_VAR, cleanEnv } from "../src/job/cleanEnv.js";
import { haltDepsFrom, killEngineHost } from "../src/engineBridge/halt.js";
import { createEngineBridgePorts } from "../src/engineBridge/ports.js";
import { createSandboxHost } from "../src/sandbox/probeHost.js";
import { interopEntryPresent } from "../src/sandbox/platform.js";
import { cacheRootsFor } from "../src/daemon/mirror.js";
import { killLoginTree, readProcessTable } from "../src/daemon/claudeLogin.js";
import { isManagedServer } from "../src/daemon/managedServer.js";
import { openLaunchDir } from "../src/launchDir.js";
import { vmBuildHost } from "../scripts/vm-host.mjs";
import { runEngineSupervise } from "../scripts/engine-supervise-host.mjs";
import { MICROVM_ENV_NAMES } from "../src/vm/sandboxd/guestEnv.js";
import { readMemAvailableBytes, vmHostFacts, vmHostFactsWithHelper } from "../scripts/vm-facts.mjs";
import { kernelFacts, resolver } from "../scripts/preflight-facts.mjs";
import { createVmInstallHosts } from "../scripts/vm-install-host.mjs";
import { buildRootArgv } from "../src/vm/install.js";
import { createHelperSandboxes } from "../src/vm/helperSandboxes.js";
import { socketPath } from "../src/vm/unitRender.js";
import { startEgressProxy } from "../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../src/vm/egress/reverse.js";
import { liveMicrovmComplete } from "../src/vm/sandboxd/live.js";
import { createMicrovmParts } from "../src/vm/liveParts.js";
import { LAYOUT } from "../src/vm/installPlan.js";
import { completeCaps } from "../src/vm/limits.js";
import { productionSnapshots } from "../src/vm/sandboxd/snapshots.js";
import { ensurePrivateDir } from "../src/engineBridge/stateFiles.js";
import { readInstalledManifest } from "../scripts/vm-read-manifest.mjs";
import { loadSettings, omitsDevToken } from "../src/runnerSettings.js";
import { hostRefusal } from "../src/vm/rootApply.js";
import { buildRemoveArgv } from "../src/vm/uninstall.js";
import { uninstallPathActions } from "../src/vm/uninstallActions.js";
import { createVmInstallFacts } from "../scripts/vm-doctor-host.mjs";
import { stateDirFor } from "../src/config.js";
import { TufClient } from "../src/update/tuf.js";
import { findChromium, openHeadedBrowser } from "../src/verifyBrowser/driver.js";
import { setPlaywrightLoader, sidecarFor } from "../src/verifyBrowser/loadPlaywright.js";
import { sidecarLibrary } from "./sidecarLibrary.mjs";
import { swapSidecar, unpackSidecar, verifySidecar } from "../scripts/sidecar.mjs";


// D#6 RUNNER-CWD-1: where every program the kit starts without a directory of its own is started (a fresh empty directory under it each time),
// and the two places such a start may never be: the home directory and this process's working directory (read at each start). No home, no launches.
const launchRoot = (() => {
  try {
    return cacheRootsFor({ home: process.env.HOME, platform: process.platform, xdgCacheHome: process.env.XDG_CACHE_HOME }).launchRoot;
  } catch {
    return undefined;
  }
})();
const launch = { root: launchRoot, home: process.env.HOME, processCwd: () => process.cwd(), uid: process.getuid?.() };
const engine = createClaudeKit(spawn, { instructionCanary: true, launch });
// D#587 B-9: the two things about WSL2 that only the kernel's own files can say. This is the one place that names them (src/ may not build a path into the process table).
const wslMachine = {
  // Either entry name means WSL2 with interop on; only a missing entry means absent, any other error counts as present (src/sandbox/platform.ts).
  interopEntry: () => interopEntryPresent((name) => lstatSync(`/proc/sys/fs/binfmt_misc/${name}`)),
  // The path with every symlink in its existing part resolved; a part that is not there yet is kept as written (D#587 B-9b: a link into /mnt must be seen).
  realPath: (target) => {
    const rest = [];
    for (let current = target; ; ) {
      try {
        return [realpathSync(current), ...rest.reverse()].join("/").replace(/\/+/g, "/");
      } catch {
        // fx-swallow-ok: this part does not exist yet; the nearest part that does is resolved instead
        const up = current.slice(0, Math.max(current.lastIndexOf("/"), 0)) || "/";
        if (up === current) return undefined;
        rest.push(current.slice(current.lastIndexOf("/") + 1));
        current = up;
      }
    }
  },
  mountinfo: () => {
    try {
      return readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      // fx-swallow-ok: an unreadable mount table is undefined, and the drvfs check fails closed on it
      return undefined;
    }
  },
};
const shellVars = [];
if (process.env.ANTHROPIC_API_KEY) shellVars.push("ANTHROPIC_API_KEY");
if (process.env.ANTHROPIC_AUTH_TOKEN) shellVars.push("ANTHROPIC_AUTH_TOKEN");

// What self-update needs (D#6 R6-2b): the version, where this program really is, whether a service manager started it (the unit sets
// FX_RUNNER_SERVICE=1), and a way to run a freshly installed program for its start check, in a clean environment and on a time limit, started in a
// fresh launch directory of its own like every other short start (D#6 RUNNER-CWD-1); a launch directory that cannot be made fails the check.
const execPath = realpathSync(process.execPath);
// D#749 V2c-2c: the digest of the Playwright sidecar this program was built with (scripts/build-sea.mjs defines it); "" in a program that was not built with one, which then never has a sidecar it trusts.
const sidecarDigest = typeof __FX_SIDECAR_DIGEST__ === "undefined" ? "" : __FX_SIDECAR_DIGEST__;
const updateHost = {
  // The updater installs a release's sidecar beside the binary with these (src/update/updater.ts); nothing under src/ imports a script.
  sidecar: {
    unpack: (bytes, dest) => {
      unpackSidecar(bytes, dest);
    },
    swap: (next, final) => swapSidecar(next, final),
    intact: (dir) => /^[0-9a-f]{64}$/.test(sidecarDigest) && verifySidecar(dir, sidecarDigest),
  },
  version: RUNNER_VERSION,
  platform: process.platform,
  arch: process.arch,
  execPath,
  inService: process.env.FX_RUNNER_SERVICE === "1",
  run: (file, args, timeoutMs) =>
    new Promise((resolve) => {
      let stdout = "";
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, FX_RUNNER_HOME: process.env.FX_RUNNER_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      let place;
      try {
        place = openLaunchDir(launch);
      } catch {
        resolve({ code: null, stdout: "" });
        return;
      }
      const done = (result) => {
        place.remove();
        resolve(result);
      };
      try {
        const child = spawn(file, args, { cwd: place.dir, env, stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, killSignal: "SIGKILL" });
        child.stdout.on("data", (chunk) => {
          if (stdout.length < 65536) stdout += chunk.toString("utf8");
        });
        child.on("error", () => done({ code: null, stdout: "" }));
        child.on("close", (exit) => done({ code: exit, stdout }));
      } catch {
        done({ code: null, stdout: "" });
      }
    }),
};

// Run from the single-executable release build (scripts/build-sea.mjs), the program is process.execPath itself and there is no script file to name:
// the bundle is CommonJS (no top-level await, no import.meta), so this file is one promise chain and the script path is only looked up when it exists.
const sea = isSea();
// D#749 V2c-2b: the Playwright library is never in the bundle. The single executable loads it from the folder laid down next to it; from source (or a plain bundle, where import.meta.url is the
// bundle's own address) Node's lookup from this file finds it. src/ may not load modules by a computed route, so this is the one place that does (src/verifyBrowser/loadPlaywright.ts).
// In the single executable the library must really lie inside that folder (bin/sidecarLibrary.mjs checks the resolved file, so a copy planted on NODE_PATH or in a parent folder is refused).
const libraryRequire = sea ? undefined : createRequire(import.meta.url ?? pathToFileURL(process.argv[1]).href);
setPlaywrightLoader(
  sea
    ? // D#749 V2c-2c: the release build bakes in the digest of the sidecar it ships with (scripts/build-sea.mjs defines __FX_SIDECAR_DIGEST__); a build that has none gets "", and nothing is available.
      sidecarLibrary(sidecarFor(process.execPath), "playwright-core", { digest: sidecarDigest })
    : {
        load: async () => libraryRequire("playwright-core"),
        available: () => {
          try {
            libraryRequire.resolve("playwright-core");
            return true;
          } catch {
            return false;
          }
        },
      },
);
// The account this runs as, for the lingering advice `doctor` prints; the account database, not the environment.
const accountName = () => {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
};
const scriptPath = () => realpathSync(fileURLToPath(import.meta.url));

// Engine bridge EB-11b: what the engine kill path (`engine-host stop`, and the cloud halt) needs from the machine. The process group kill is the runner's
// existing one (processGroup.ts); `ps` and `systemctl --user` get only these three variables.
// When a process started, so a handle can name its host and the kill path can tell a reused pid from it: field 22 of the stat file (Linux; off Linux the kill path asks `ps`).
// The name (field 2) may hold spaces and brackets, so the fields are counted after its closing bracket.
const processStartTime = (pid) => {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
};
const engineHaltDeps = haltDepsFrom({
  platform: process.platform,
  uid: process.getuid?.(),
  ownPid: process.pid,
  runFile: execFile,
  readFile: readFileSync,
  readPidStart: processStartTime,
  // A process's cgroup file, so the kill path can confirm a pid belongs to the engine host's scope before it signals the pid's group. The path is named here only.
  readPidCgroup: (pid) => {
    try {
      return readFileSync(`/proc/${Number(pid)}/cgroup`, "utf8");
    } catch {
      return undefined;
    }
  },
  // The cgroup mount is named here only, like the process table above: src/ names neither.
  cgroupProcsFile: (controlGroup) => `/sys/fs/cgroup${controlGroup}/cgroup.procs`,
  terminateGroup: (pgid, graceMs) =>
    terminateGroup(
      {
        pid: pgid,
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
          try {
            return process.kill(pgid, signal);
          } catch {
            return false;
          }
        },
      },
      graceMs,
    ),
  env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
});

// Engine bridge EB-12a: what `engine-host start` needs. The host is started as the leader of its own process group, with a fixed allowlist of six variables (no
// credential among them: the CLI reads its own login), and every pipe is handed over as text. Ctrl-C and SIGTERM are caught only once `start` asks for them.
const engineHostEnv = Object.fromEntries(
  Object.entries({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    AUTONOMOUS_TEAM_STATE_DIR: process.env.AUTONOMOUS_TEAM_STATE_DIR,
    LANG: process.env.LANG,
  }).filter(([, v]) => v !== undefined),
);
// D#845 MC-8b: what the Claude sign-in link needs to start the installed CLI: the path the job runner resolves (its clean search path), a fixed allowlist of variables with no credential, no BROWSER
// and no DISPLAY, and a process start that makes the child the leader of its own process group. `script` starts the CLI in a NEW session, so the group alone does not reach it: the kill reads the process
// table below the child and ends that tree too (killLoginTree). Output is handed over as text and is never kept here.
const loginProcs = readProcessTable({
  pids: () => {
    try {
      return readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)).map(Number);
    } catch {
      return [];
    }
  },
  stat: (pid) => {
    try {
      return readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
    } catch {
      return undefined;
    }
  },
});
const loginKillPorts = {
  ...loginProcs,
  signal: (target, sig) => {
    try {
      process.kill(target, sig);
    } catch {
      // the process or group is already gone
    }
  },
  after: (ms, fn) => void setTimeout(fn, ms),
};
const claudeLoginEnv = () =>
  Object.fromEntries(
    Object.entries({ HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TMPDIR: process.env.TMPDIR, TERM: "xterm", COLUMNS: "200" }).filter(([, v]) => v !== undefined),
  );
const claudeLogin = {
  locateClaude: () => {
    try {
      return resolveClaudePath(cleanEnv({ mode: "subscription" }).PATH ?? "");
    } catch {
      return undefined;
    }
  },
  // D#845 ON-19c: the installed `gh`, found on the same clean search path (an absolute directory, a real file the runner may execute); none found means no GitHub sign-in can start.
  locateGh: () => {
    for (const dir of (cleanEnv({ mode: "subscription" }).PATH ?? "").split(path.delimiter)) {
      if (dir === "" || !path.isAbsolute(dir)) continue;
      try {
        const real = realpathSync(path.join(dir, "gh"));
        if (lstatSync(real).isFile()) {
          accessSync(real, fsConstants.X_OK);
          return real;
        }
      } catch {
        // a directory without a runnable gh is skipped
      }
    }
    return undefined;
  },
  env: () => ({ ...claudeLoginEnv(), PATH: cleanEnv({ mode: "subscription" }).PATH ?? "" }),
  launch: (spec) => {
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: spec.ignoreStdio === true ? ["ignore", "ignore", "ignore"] : ["pipe", "pipe", "pipe"] });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdin?.on("error", () => undefined); // the CLI may exit before it has read everything
    let exited = false;
    const exitCallbacks = [];
    const onceExit = (code) => {
      if (exited) return;
      exited = true;
      for (const cb of exitCallbacks) cb(code);
    };
    child.on("error", () => onceExit(null)); // a start that failed has no pid
    child.on("close", (code) => onceExit(code)); // after the pipes have drained, so the last output is read before the end
    return {
      write: (text) => void child.stdin?.write(text),
      onOutput: (cb) => {
        child.stdout?.on("data", cb);
        child.stderr?.on("data", cb);
      },
      onExit: (cb) => (exited ? cb(null) : void exitCallbacks.push(cb)),
      kill: () => {
        if (child.pid !== undefined) killLoginTree(loginKillPorts, child.pid);
      },
    };
  },
};
// D#845 ON-21: the readers behind the preflight list, given to `doctor` and (D#845 ON-21b) to `run`, which reports the codes only.
const preflightReaders = { kernel: (input) => kernelFacts({ ...input, readMemAvailableBytes: () => readMemAvailableBytes() }), lookup: resolver };

const engineHostRuntime = {
  platform: process.platform,
  // The path the job runner resolves (its clean search path, as `doctor` and `run` use), never the PATH of whatever shell or service started this; then the same version and flag check every job gets.
  locateClaude: () => resolveClaudePath(cleanEnv({ mode: "subscription" }).PATH ?? ""),
  inspectClaude: async (binaryPath, stateDir) => {
    const report = await engine.inspect({ binaryPath, envOptions: { omitSubscriptionToken: omitsDevToken(stateDir) }, stateDir, loginMode: undefined });
    return report.versionSupported && report.missingFlags !== undefined && report.missingFlags.length === 0;
  },
  ownPid: process.pid,
  // Field 22 of the stat file is the start time; the name (field 2) may hold spaces and brackets, so the fields are counted after its closing bracket.
  processStart: processStartTime,
  readCgroup: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/cgroup`, "utf8");
    } catch {
      return undefined;
    }
  },
  onProcessExit: (fn) => process.once("exit", fn),
  launch: (spec) => {
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => undefined); // the host may exit before it has read everything
    child.on("error", () => undefined); // a start that failed has no pid; the supervisor counts it as a crash
    return {
      pid: child.pid,
      write: (text) => void child.stdin.write(text),
      closeStdin: () => child.stdin.end(),
      onStdout: (cb) => child.stdout.on("data", cb),
      onStderr: (cb) => child.stderr.on("data", cb),
      onExit: (cb) => child.on("exit", () => cb()),
    };
  },
  env: engineHostEnv,
  isAlive: (pid) => {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  },
  scopeAvailable: async () => (await engineHaltDeps.capture("systemd-run", ["--user", "--scope", "--quiet", "--", "true"])).code === 0,
  killHost: (handle) => killEngineHost(handle, engineHaltDeps),
  killScope: async (unit) => void (await engineHaltDeps.capture("systemctl", ["--user", "kill", "--signal=SIGKILL", "--", unit])),
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  shutdown: () =>
    new Promise((resolve) => {
      process.once("SIGINT", () => resolve("stopped_by_person"));
      process.once("SIGTERM", () => resolve("machine_shutdown"));
      process.once("SIGHUP", () => resolve("machine_shutdown")); // the terminal was closed
    }),
};

// D#587 B-2a-2: `vm install` reads the machine here and makes its one root call here; the verified downloads use the same TUF client the updater does.
// The client is made on first use, not at start: its state directory needs a home directory, and the verify server runs with an environment that has none.
let tufClient;
const vmTuf = () => (tufClient ??= new TufClient({ stateDir: stateDirFor(process.env.HOME, process.env.FX_RUNNER_HOME) }));
// One lazy port shared by the install hosts and the doctor facts; neither builds the client until it calls a method.
const vmTufPort = { listTargets: (...args) => vmTuf().listTargets(...args), fetchTarget: (...args) => vmTuf().fetchTarget(...args) };
// D#587 B-5b-3c-iii: every part of the live microVM stack. `createLiveMicrovm` wires it only when all of them are usable (`microvm_build_unwired` otherwise, so a runner set to `microvm`
// claims nothing and never falls back to the OS sandbox). The boot facts come from the signed release listing (the TUF client above) and the installed manifest; the model token is
// read in `readToken` and nowhere else, as a fresh buffer on each call.
// D#845 ON-13b2 (Ruling 81.1a): the snapshot deps from the runner's two snapshot limits, the file system's free space and the daemon's own 0700 state directory. Any part that cannot be had (no home directory, a limit not set) leaves none.
function sessionSnapshots() {
  try {
    const dir = stateDirFor(process.env.HOME, process.env.FX_RUNNER_HOME);
    return productionSnapshots({
      sandboxdDir: path.join(dir, "sandboxd"),
      uid: process.getuid?.(),
      caps: completeCaps(loadSettings(dir).microvm),
      freeBytes: (target) => {
        try {
          const stats = statfsSync(target);
          return stats.bavail * stats.bsize;
        } catch {
          return undefined; // the snapshot is then refused: the free space could not be read
        }
      },
      ensureDir: ensurePrivateDir,
    });
  } catch {
    return undefined;
  }
}
const microvmParts = createMicrovmParts({
  euid: process.geteuid?.(),
  uid: process.getuid?.(),
  platform: process.platform,
  helperSocket: socketPath(),
  tuf: vmTufPort,
  readManifest: () => readInstalledManifest(LAYOUT.templateManifest),
  nodeArch: process.arch,
  now: Date.now,
  egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint },
  logDir: () => path.join(stateDirFor(process.env.HOME, process.env.FX_RUNNER_HOME), "logs"),
  // The one read of the model token for a VM run: a fresh buffer per call, zeroed by the token step after the send. Absent or empty is an empty buffer, which the token step refuses.
  // The file `fx-runner credentials set-vm-token` wrote first; the environment variable only when that file is missing (a foreground dev run). Read at job start, so a new token applies from the next job.
  readToken: () => readVmToken(stateDirFor(process.env.HOME, process.env.FX_RUNNER_HOME), process.getuid?.(), devVmToken),
  // D#845 ON-13b2 (Ruling 81.1a): what lets an engine session's VM keep a snapshot at a stop; undefined (no snapshots, so a session's stop ends `snapshot_failed`) when the limits or the state directory are not usable.
  snapshots: sessionSnapshots(),
});
// The dev fallback's one environment read, by name (this line only): the value is handed to `readVmToken` (the file comes first) and, as a yes or no, to `doctor`; `run` gets the same getter for the hello.
const devVmToken = () => process.env[SUBSCRIPTION_TOKEN_VAR];
const vmInstallHosts = createVmInstallHosts({
  // Read when uninstall runs, not at start: it needs a home directory, and the verify server has none.
  get stateDir() {
    return stateDirFor(process.env.HOME, process.env.FX_RUNNER_HOME);
  },
  createHelper: createHelperSandboxes,
  helperSocket: socketPath(),
  snapshotDirOf: (dir) => loadSettings(dir).microvm?.snapshotDir,
  buildRootArgv,
  buildRemoveArgv,
  hostRefusalRemove: (actions) => hostRefusal(uninstallPathActions(actions), "", "vm uninstall"),
  hostRefusal: (actions) => hostRefusal(actions),
  selfCommand: sea ? [process.execPath] : [process.execPath].concat(process.execArgv, [scriptPath()]),
  tuf: vmTufPort,
  confirm: async (question) => /^y(es)?$/i.test((await askOnTerminal(process.stdin, (text) => process.stdout.write(text), question, 120000)) ?? "n"),
});

let sigint; // the Ctrl-C listener `setup` installs and releases (see setupHost.terminal)
runCli({
  vmInstallHosts,
  updateHost,
  argv: process.argv.slice(2),
  home: process.env.HOME,
  stateDirOverride: process.env.FX_RUNNER_HOME,
  engineStateDirOverride: process.env.AUTONOMOUS_TEAM_STATE_DIR,
  // Host facts for `engine-bridge enable` discovery: the current directory and the extra search roots (colon separated, absolute).
  engineDiscovery: { cwd: process.cwd(), searchRoots: process.env.FX_RUNNER_SEARCH_ROOTS },
  engineHaltDeps,
  engineHostRuntime,
  // D#845 ON-13b1: the engine session's supervisor, held in a standard-tier session's unit. The sandbox gives it the microVM table's variables and the CLI's path (FX_ENGINE_CLAUDE); its state is under its own root.
  engineSupervise: () =>
    process.env.FX_ENGINE_CLAUDE === undefined
      ? Promise.resolve(2)
      : runEngineSupervise({
          dir: process.env.FX_ENGINE_DIR ?? path.join(process.cwd(), ".fx-engine"),
          claudePath: process.env.FX_ENGINE_CLAUDE,
          env: Object.fromEntries([...MICROVM_ENV_NAMES].map((name) => [name, process.env[name]]).filter(([, value]) => value !== undefined)),
        }).then((code) => process.exit(code)), // the program ENDS after a stop or crash_loop (no credential copy may outlive it), open handles or not
  // A file holding the Vercel protection bypass secret, for a staging or protected-preview cloud. Only the path is read here; src/protectionBypass.ts reads the file.
  protectionBypassFile: process.env.FX_RUNNER_PROTECTION_BYPASS_FILE,
  uid: process.getuid?.(),
  platform: process.platform,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
  // The one place standard input is touched: the API key is read here, never taken from the command line.
  readSecret: () => readSecret(process.stdin, (text) => process.stderr.write(text), API_KEY_MAX_BYTES),
  // The microVM Claude token: a hidden prompt or standard input, never an argument.
  readVmToken: () => readSecret(process.stdin, (text) => process.stderr.write(text), VM_TOKEN_MAX, { prompt: VM_TOKEN_PROMPT, tooLong: () => new VmTokenError("vm_token_format") }),
  // Likewise the registration code or token (`register --code-stdin`): never taken from the command line.
  readCode: () =>
    readSecret(process.stdin, (text) => process.stderr.write(text), CODE_MAX_BYTES, {
      prompt: "Registration code or token (what you type is not shown): ",
      tooLong: () => new CliError("the registration code or token is too long", 2),
    }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  host: {
    home: process.env.HOME,
    platform: process.platform,
    vmEnvToken: devVmToken,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    signals: process,
    pid: process.pid,
    kill: (pid, signal) => process.kill(pid, signal),
    // `run` changes to its own empty directory under the launch root before it starts anything (D#6 RUNNER-CWD-1).
    chdir: (dir) => process.chdir(dir),
    engine,
    sandbox: createSandboxHost(engine.captureWithStderr, wslMachine),
    // How a tmux pane starts this program again (the watch and take-over panes), the terminal type, and the one question take-over asks.
    selfCommand: sea ? [process.execPath] : [process.execPath].concat(process.execArgv, [scriptPath()]),
    term: process.env.TERM,
    uid: process.getuid?.(),
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    // D#845 ON-13b1 (Ruling 115): the held supervisor on the standard tier is opt-in until a real bwrap run proves it can start the CLI; the idle holder is the default.
    engineSupervise: process.env.FX_ENGINE_SUPERVISE === "1",
    // D#842 EB-3c: the engine bridge's halt path and dial ceiling keeper, bound to the machine through the same kill-path dependencies `engine-host stop` uses. Without them `run` never starts the bridge.
    engineBridge: createEngineBridgePorts(engineHaltDeps),
    // D#845 MC-8b: the Claude sign-in link's process start (Linux only; `run` refuses it elsewhere).
    claudeLogin,
    // D#845 MC-8b: whether the cloud's own install path set this machine up (the root-written marker its bootstrap leaves); only such a machine advertises and runs the sign-in link.
    managedServer: () => isManagedServer(),
    // D#845 ON-21b: the same kernel readings and resolver `doctor` uses; `run` reports the codes of its preflight on the hello only to a cloud that listed the `preflight` capability.
    preflight: preflightReaders,
    // D#587 B-5a part 3: what a runner set to `microvm` checks before every claim until it passes: KVM, the helper's socket and the helper's own answer.
    vmFacts: () => vmHostFactsWithHelper(),
    microvm: microvmParts,
    // D#749 V2b: the Chrome bridge directory is named for the user; a deploy command is given a short allowlist of this environment (src/daemon/deployOrder.ts).
    username: userInfo().username,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TMPDIR: process.env.TMPDIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME },
    // The take-over confirmation must be typed by a person: a piped stdin is not one.
    interactive: process.stdin.isTTY === true,
    // D#601 MEM-6: the memory-proposal question; the answer is read from the terminal only (src/ttyAsk.ts), and a timeout or a closed input is no answer.
    askTimed: (question, timeoutMs, signal) => askOnTerminal(process.stdin, (text) => process.stdout.write(text), question, timeoutMs, signal),
    ask: async (question) => {
      const lines = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await lines.question(question);
      } finally {
        lines.close();
      }
    },
  },
  doctorHost: { platform: process.platform, vmEnvToken: (devVmToken() ?? "") !== "", shellVars, engine, home: process.env.HOME, cwd: process.cwd(), shell: process.env.SHELL, xdgCacheHome: process.env.XDG_CACHE_HOME, uid: process.getuid?.(), xdgRuntimeDir: process.env.XDG_RUNTIME_DIR, xdgConfigHome: process.env.XDG_CONFIG_HOME, userName: accountName(), sandbox: createSandboxHost(engine.captureWithStderr, wslMachine), update: { version: RUNNER_VERSION, execPath }, vm: vmHostFacts(), microvmWired: liveMicrovmComplete(microvmParts), vmInstall: createVmInstallFacts({ tuf: vmTufPort }), preflight: preflightReaders },
  vmHost: vmBuildHost,
  // D#845 ON-3: `setup` and a code-less `register`. Ctrl-C is listened for only once one of them asks (every other command keeps the default), the one question is read from the
  // terminal only (a pipe or a timeout is no answer), and the service start is two fixed programs with a fixed environment, no shell.
  setupHost: {
    terminal: {
      signal: () => {
        const controller = new AbortController();
        sigint = () => controller.abort();
        process.once("SIGINT", sigint);
        return controller.signal;
      },
      release: () => {
        if (sigint !== undefined) process.removeListener("SIGINT", sigint);
        sigint = undefined;
      },
      askEnter: (question, signal) => askOnTerminal(process.stdin, (text) => process.stdout.write(text), question, 15 * 60_000, signal),
    },
    run: async (argv) => {
      const env = { PATH: "/usr/bin:/bin:/run/current-system/sw/bin:/usr/local/bin", HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };
      const result = spawnSync(argv[0], argv.slice(1), { env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)), stdio: "ignore", timeout: 60000 });
      return result.error !== undefined || result.status === null ? -1 : result.status;
    },
  },
  // D#749 V2c-2b: the verify browser. The MCP server gets the process's own streams and ONLY the variables the browser may inherit (the driver allowlists again); `verify-login` gets a headed browser and the terminal.
  verifyServerHost: {
    input: process.stdin,
    output: process.stdout,
    env: { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE, FONTCONFIG_PATH: process.env.FONTCONFIG_PATH },
  },
  verifyLoginHost: {
    home: process.env.HOME,
    findHeaded: () => findChromium({ PATH: process.env.PATH, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }, { headed: true }),
    openHeaded: openHeadedBrowser,
    interactive: process.stdin.isTTY === true,
    // Resolves on a line, or with "eof" when standard input ends first (never a hang).
    waitForEnter: () =>
      new Promise((resolve) => {
        const done = (value) => {
          process.stdin.off("data", onData);
          process.stdin.off("end", onEnd);
          process.stdin.off("close", onEnd);
          process.stdin.pause();
          resolve(value);
        };
        const onData = () => done(undefined);
        const onEnd = () => done("eof");
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", onData);
        process.stdin.once("end", onEnd);
        process.stdin.once("close", onEnd);
      }),
  },
  serviceHost: {
    home: process.env.HOME,
    platform: process.platform,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    command: sea ? [process.execPath, "run"] : [process.execPath, scriptPath(), "run"],
    path: process.env.PATH,
    execPath,
    // Only the account list is read, for the check that a system service's account exists and is not root (Linux).
    passwd: () => {
      try {
        return readFileSync("/etc/passwd", "utf8");
      } catch {
        return undefined;
      }
    },
    // What the check on a system service's program location reads: the mode bits and link-ness of one path, never followed.
    lstat: (file) => {
      try {
        const info = lstatSync(file);
        return { mode: info.mode, isSymbolicLink: info.isSymbolicLink() };
      } catch {
        return undefined;
      }
    },
    // macOS only, for the same account check: the fixed argument list of the directory service tool, no shell and no inherited environment.
    accountUid: (name) => {
      const found = spawnSync("/usr/bin/dscl", [".", "-read", `/Users/${name}`, "UniqueID"], { encoding: "utf8", env: {}, timeout: 10000 });
      if (found.error !== undefined || found.status === null) return undefined;
      if (found.status !== 0) return /eDSRecordNotFound|DS Error: -14136/.test(`${found.stdout}${found.stderr}`) ? null : undefined;
      const match = /^UniqueID:\s*(\d+)\s*$/m.exec(found.stdout);
      return match === null ? undefined : Number(match[1]);
    },
  },
}).then((code) => {
  process.exitCode = code;
});
