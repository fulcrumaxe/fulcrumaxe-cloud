import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DoneMessage, sha256Text } from "@fulcrumaxe/runner-protocol";
import { runCommand, type RunHooks, type RunHost } from "../../src/commands/run.js";
import { CliError } from "../../src/cliError.js";
import type { CommandContext } from "../../src/context.js";
import { saveRegistration } from "../../src/config.js";
import { endOfFailure } from "../../src/daemon/runEnded.js";
import { createClaudeKit } from "../../src/engines/claude/kit.js";
import { generateRunnerKey, saveRunnerKey } from "../../src/keys.js";
import { originHash } from "../../src/keyring.js";
import { setSetting } from "../../src/runnerSettings.js";
import { startEgressProxy } from "../../src/vm/egress/proxy.js";
import { startReverseEndpoint } from "../../src/vm/egress/reverse.js";
import { createMicrovmParts } from "../../src/vm/liveParts.js";
import { TEMPLATES } from "../../src/vm/lock.js";
import { parseMemAvailableBytes, type VmHostFacts } from "../../src/vm/limits.js";
import { GuestBindings } from "../../src/vm/sandboxd/guestBindings.js";
import { guestMakeRuntime } from "../../src/vm/sandboxd/guestRuntime.js";
import { createGuestAgent } from "../../src/vm/sandboxd/guestAgent.js";
import { createHelperClient, HelperError, type Helper } from "../../src/vm/sandboxd/helperClient.js";
import type { LiveMicrovmParts } from "../../src/vm/sandboxd/live.js";
import { fixtureText, makeFake, type Fake } from "../engines/claude/harness.js";
import { fakeSandboxHost } from "../helpers/fakeSandboxHost.js";
import { shellSandboxUsable, testLaunch } from "../helpers/launch.js";
import { until } from "../helpers/manualClock.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";
import { KEYRING, signedJob } from "../helpers/signedJob.js";
import { socketTmpRoot } from "../helpers/tmpRoot.js";
import { AGENT_PROBE, bwrapUsable, cliScript, DISKSCAN, FILE_IN_GUEST, HANG, onPath, osToolbin, CLI } from "./helpers/scriptedCli.js";
import { signRelease, type SignedRelease } from "./helpers/signedRelease.js";
import { connectUnix } from "./sandboxd/helpers.js";

/**
 * D#587 B-5b-3c-iv (A1 criterion 26, parts 26a and 26b) against a REAL Firecracker: a whole job goes through the real `run` command (`runCommand`, the composed daemon, the job
 * handler, `runVmJob`, the production VM port, the real helper, real VMs), against the strict stand-in for the cloud. Only three things are stand-ins, and each is the least that can be:
 *   - the cloud (the protocol's strict fake, over real HTTP),
 *   - the agent CLI inside the guest: one small program written into the guest, speaking stream-json (the real `claude` against a model is criterion 26's other half and is not run here),
 *   - the signed boot facts come from a TEST release (throwaway keys, a test root) of the disks the dispatched run built; the gate still checks the listing.
 * Everything between those is production code: the claim, the token step, the working copy crossing, the guest run, the bundle, the host's apply, the push, the approved check in a
 * fresh VM, the end and the teardown.
 *
 * Needs, in the environment (a dispatched `microvm-image.yml` run sets all of them): FX_VM_HELPER_SOCKET, FX_VM_TEMPLATE, FX_VM_KERNEL, FX_VM_ROOTFS, FX_VM_AGENT. Runs as the ordinary
 * user, never as root, and skips with a message without them (or with little free memory). One job, so one VM at a time: run it behind the heavy-check lock.
 *
 * What the test can see of the VMs is what the helper was asked: the helper handed to the daemon is wrapped, so every sandbox id this file made is known, the helper's list the runner
 * reaps from shows only those (a start-up reap must never end another suite's VMs), and a failure can be injected at the one call under test. The leak checks read the REAL helper.
 */
const env = { helper: process.env["FX_VM_HELPER_SOCKET"], template: process.env["FX_VM_TEMPLATE"], kernel: process.env["FX_VM_KERNEL"], rootfs: process.env["FX_VM_ROOTFS"], agent: process.env["FX_VM_AGENT"] };
const ready = env.helper !== undefined && env.template === TEMPLATES[0] && env.kernel !== undefined && env.rootfs !== undefined && env.agent !== undefined && process.geteuid !== undefined && process.geteuid() !== 0 && freemem() > 2.5 * 2 ** 30;
if (!ready) console.warn("vmJob.real: FX_VM_HELPER_SOCKET, FX_VM_TEMPLATE, FX_VM_KERNEL, FX_VM_ROOTFS and FX_VM_AGENT are not all set (or this is root, or memory is low); the real-VM job suite is skipped");

type Done = ReturnType<typeof DoneMessage.parse>;
const GB = 1024 ** 3;
const CGROUP_ROOT = "/sys/fs/cgroup";

type Call = { verb: "prepare" | "start" | "destroy"; id: string };
interface Injection {
  /** `prepare` (the helper's create) answers a refusal. */
  prepare: boolean;
  /** `destroy` answers a refusal, so a VM cannot be ended: the teardown-incomplete path. */
  destroy: boolean;
}

const firecrackersFor = (id: string): number => {
  const out = spawnSync("pgrep", ["-f", id], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.split("\n").filter((l) => l !== "").length : 0;
};

/** The cgroup directories named for a sandbox id, below the cgroup mount (the helper makes one per VM and removes it with the VM). A tree this user cannot read answers none, which the control in `start` shows. */
const cgroupDirsOf = (id: string): string[] => {
  const out = spawnSync("find", [CGROUP_ROOT, "-maxdepth", "8", "-type", "d", "-name", id], { encoding: "utf8" });
  return out.stdout.split("\n").filter((l) => l !== "");
};

/** What `lstat` says of a path: "present", "gone", or "unreadable" (a directory this user may not search says nothing of what is below it). */
const stateOf = (file: string): "present" | "gone" | "unreadable" => {
  try {
    lstatSync(file);
    return "present";
  } catch (error) {
    // fx-swallow-ok: the answer is the point; only ENOENT is "gone"
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unreadable";
  }
};

/** Every regular file under `dir` that holds `needle`. A link is not followed, and a very large file is skipped (a disk image is not under here). */
function filesHolding(dir: string, needle: Buffer): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && lstatSync(file).size < 64 * 2 ** 20 && readFileSync(file).includes(needle)) found.push(file);
    }
  };
  walk(dir);
  return found;
}

describe.skipIf(!ready)("a whole job through the real run path, in real microVMs (criterion 26a and 26b)", () => {
  let signed: SignedRelease;
  let realHelper: Helper;
  let root: string;
  let home: string;
  let stateDir: string;
  let remote: string;
  let cloud: StrictRunnerCloud;
  let fake: Fake;
  let toolbin: string;
  let key: ReturnType<typeof generateRunnerKey>;
  let sentinel: string;
  let calls: Call[];
  let own: Set<string>;
  let injection: Injection;
  let seenByPgrep: Map<string, number>;
  /** What the REAL helper said of each VM when it started: where its vsock directory is, and how many cgroup directories of that name the kernel showed (the controls for the leak checks below). */
  let vsockDirs: Map<string, string>;
  /** Which of the vsock directory and its sockets were seen "present" while the VM ran (the control for the "gone" checks below). */
  let vsockSeenPresent: Map<string, Set<string>>;
  let cgroupsSeen: Map<string, number>;
  const logLines: string[] = [];
  const started: Array<{ signals: EventEmitter; done: Promise<unknown> }> = [];

  const git = (...args: string[]): string =>
    execFileSync("git", args, { env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** A bare repository with one commit on `main`, which the runner reaches by file URL. */
  const seedRemote = (name: string): string => {
    const bare = path.join(root, `${name}.git`);
    git("init", "--bare", "-b", "main", bare);
    const seed = path.join(root, `${name}-seed`);
    git("init", "-b", "main", seed);
    writeFileSync(path.join(seed, "README.md"), "hello\n");
    git("-C", seed, "add", "README.md");
    git("-C", seed, "commit", "-m", "first");
    git("-C", seed, "push", bare, "main");
    return bare;
  };

  beforeAll(async () => {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    signed = await signRelease({ template: TEMPLATES[0], files: [{ kind: "kernel", arch, file: env.kernel as string }, { kind: "rootfs", arch, file: env.rootfs as string }, { kind: "agent", arch, file: env.agent as string }] });
    realHelper = createHelperClient(connectUnix(env.helper as string));
  }, 120_000);
  afterAll(async () => {
    await signed?.close();
  });

  beforeEach(async () => {
    root = mkdtempSync(path.join(socketTmpRoot(), "fxr-vmjob-"));
    home = path.join(root, "home");
    stateDir = path.join(home, ".fx-runner");
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", "");
    // a test that could reach GitHub must not: nothing here asks for it, and a stray call fails at once
    vi.stubEnv("GH_TOKEN", "invalid");
    vi.stubEnv("GITHUB_TOKEN", "invalid");
    vi.stubEnv("GH_HOST", "invalid.localhost");
    sentinel = `sk-ant-oat01-${randomBytes(24).toString("hex")}`;
    calls = [];
    own = new Set();
    injection = { prepare: false, destroy: false };
    seenByPgrep = new Map();
    vsockDirs = new Map();
    vsockSeenPresent = new Map();
    cgroupsSeen = new Map();
    logLines.length = 0;
    cloud = await startStrictRunnerCloud();
    // the host's own `claude` is never used by a microVM job; the runner still looks for one at start
    fake = makeFake({ stream: fixtureText("stream.subscription.jsonl").split("\n")[0]! + "\n" });
    toolbin = path.join(root, "toolbin");
    mkdirSync(toolbin);
    for (const name of ["bwrap", "socat"]) {
      writeFileSync(path.join(toolbin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(toolbin, name), 0o755);
    }
    symlinkSync(fake.binary, path.join(toolbin, "claude"));
    key = generateRunnerKey();
    saveRunnerKey(stateDir, key);
    saveRegistration(stateDir, { version: 1, cloud_origin: cloud.origin, runner_id: randomUUID(), account_id: randomUUID(), credential_mode: "subscription", jkt: key.jkt, registered_at: new Date().toISOString() });
    cloud.trust(key.publicJwk);
    // the repository the job works on: one commit on `main`, served from a bare repository by file URL
    remote = seedRemote("remote");
    setSetting(stateDir, "sandbox_engine", "microvm");
    for (const [k, v] of [["microvm.max_vms", "2"], ["microvm.max_vcpus", "4"], ["microvm.max_memory_mb", "4096"], ["microvm.snapshot_dir", path.join(home, "snaps")], ["microvm.snapshot_quota_bytes", "1073741824"]] as const) setSetting(stateDir, k, v);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // a run a failed test left going is stopped first (bounded), so it cannot poll a closed cloud or hold a VM
    injection.destroy = false;
    for (const run of started.splice(0)) {
      run.signals.emit("SIGTERM");
      await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 90_000))]);
    }
    // whatever a test left (a deliberate leftover, or a failure half way) is ended here, through the real helper, so the next test and the other suites start clean
    injection.destroy = false;
    for (const id of own) await realHelper.destroy(id).catch(() => undefined); // fx-swallow-ok: an id the helper no longer holds is the wanted state
    await cloud.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  });

  /** The helper the daemon is given: the real one, recording each call, listing only this file's VMs, and refusing the call a test names. */
  /** Records which of the vsock directory and the socket names are there now, while the VM is up. */
  const VSOCK_NAMES = ["v.sock", "v.sock_5253", "v.sock_5254"];
  const noteVsock = (id: string): void => {
    const dir = vsockDirs.get(id);
    if (dir === undefined) return;
    const seen = vsockSeenPresent.get(id) ?? new Set<string>();
    if (stateOf(dir) === "present") seen.add(dir);
    for (const name of VSOCK_NAMES) if (stateOf(path.join(dir, name)) === "present") seen.add(path.join(dir, name));
    vsockSeenPresent.set(id, seen);
  };
  const wrapHelper = (real: Helper): Helper => ({
    ...real,
    prepare: async (p) => {
      calls.push({ verb: "prepare", id: p.sandboxId });
      if (injection.prepare) throw new HelperError("unavailable");
      own.add(p.sandboxId);
      return real.prepare(p);
    },
    start: async (id) => {
      calls.push({ verb: "start", id });
      const started = await real.start(id);
      seenByPgrep.set(id, firecrackersFor(id)); // the control for the leak check below: this matcher can see a running VM here
      vsockDirs.set(id, started.vsockDir);
      noteVsock(id);
      cgroupsSeen.set(id, cgroupDirsOf(id).length);
      return started;
    },
    destroy: async (id) => {
      calls.push({ verb: "destroy", id });
      noteVsock(id); // the VM is still up here, and the relays have made their sockets by now
      if (injection.destroy) throw new HelperError("unavailable");
      return real.destroy(id);
    },
    list: async () => (await real.list()).filter((e) => own.has(e.sandboxId)),
  });

  /** The machine's facts as `run` reads them: KVM and the helper are there, and the free memory is read for real at each admission. */
  const vmFacts = async (): Promise<VmHostFacts> => ({ kvm: "present", helperSocket: "present", helperSocketPath: env.helper as string, helperState: "ready", totalMemMb: 16384, cpus: 4, readMemAvailableBytes: () => parseMemAvailableBytes(readFileSync("/proc/meminfo", "utf8")) });

  /** The live parts, as the entry point makes them, with the CLI stand-in written into each guest before the CLI starts. */
  const partsFor = (script: string, over: { silentGuest?: boolean } = {}): LiveMicrovmParts => {
    const d = signed.digests(process.arch === "arm64" ? "arm64" : "amd64");
    const logDir = path.join(stateDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const made = createMicrovmParts({
      euid: process.geteuid?.(),
      uid: process.getuid?.(),
      platform: process.platform,
      helperSocket: env.helper as string,
      tuf: signed.client,
      readManifest: () => JSON.stringify({ [TEMPLATES[0]]: { kernel: d.kernel, rootfs: d.rootfs } }),
      nodeArch: process.arch,
      now: Date.now,
      egress: { startProxy: startEgressProxy, startReverse: startReverseEndpoint },
      logDir: () => logDir,
      readToken: () => Buffer.from(sentinel),
    });
    const bindings = new GuestBindings();
    const inner = guestMakeRuntime({ credentials: { mode: "subscription" }, logDir, agentPath: CLI }, bindings.binding);
    return {
      ...made,
      // a silent guest: the VM is real and is started by the real helper, but the runner's agent client never gets an answer from it (a connect that never completes), which is a guest that never answers
      deps: { ...made.deps, helper: wrapHelper(made.deps.helper), ...(over.silentGuest === true ? { bootTimeoutMs: 4_000, agentFor: () => createGuestAgent(() => new Promise(() => undefined), 300) } : {}) },
      bindings,
      makeRuntime: (guest, job) => {
        const runtime = inner(guest, job);
        return { ...runtime, start: async (opts) => (await guest.writeFiles([{ path: CLI, content: script, mode: 0o755 }]), runtime.start(opts)) };
      },
    };
  };

  const tool = fixtureText("stream.tooluse.synthetic.jsonl").split("\n").filter((l) => l !== "");
  /** The agent CLI stand-in's text: for the guest by default; `os` is the same program for the OS sandbox (this machine's interpreter and git), `scan` makes it hold the token as two halves so it can search for it. */
  const scriptFor = (o: { os?: boolean; scan?: boolean } = {}): string =>
    cliScript(createHash("sha256").update(sentinel).digest("hex"), tool[0]!, tool.find((l) => l.includes('"type":"result"'))!, { python: o.os === true ? (onPath("python3") as string) : "/usr/bin/python3", git: o.os === true ? (onPath("git") as string) : "git", ...(o.scan === true ? { needle: sentinel } : {}) });

  const queuedJob = (over: Parameters<typeof signedJob>[0] = {}) => signedJob({ issued_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...over });
  const check = (command: string) => ({ argv: ["sh", "-c", command], dev_shell: false, timeout_s: 120 });

  interface Started {
    signals: EventEmitter;
    done: Promise<{ code: number; message: string }>;
  }
  /** Starts the real `run` command in the background, against the stand-in cloud. */
  function startRun(parts: LiveMicrovmParts | undefined, os?: { searchPath: string }): Started {
    const signals = new EventEmitter();
    const ctx: CommandContext = { stateDir, out: (l) => logLines.push(l), err: (l) => logLines.push(l), now: () => new Date(), fetchFn: fetch };
    const host: RunHost = { home, platform: "linux", signals: signals as unknown as RunHost["signals"], pid: process.pid, kill: (pid, signal) => process.kill(pid, signal), chdir: () => undefined, engine: createClaudeKit(spawn, { launch: testLaunch(), bashSandboxUnusable: shellSandboxUsable }), sandbox: fakeSandboxHost(), ...(parts === undefined ? {} : { vmFacts, microvm: parts }) };
    const hooks: RunHooks = { keyrings: { [originHash(cloud.origin)!]: KEYRING }, searchPath: os?.searchPath ?? toolbin, probe: { read: () => ({ totalMemBytes: 64 * GB, availMemBytes: 60 * GB, load1: 0, cores: 32, freeDiskBytes: 500 * GB }) }, jobLimits: { enforced: true }, remoteUrl: () => pathToFileURL(remote).href };
    const done = runCommand(ctx, host, hooks).then(
      (code) => ({ code, message: "" }),
      (error: unknown) => {
        if (!(error instanceof CliError)) throw error;
        return { code: error.exitCode, message: error.message };
      },
    );
    const run = { signals, done };
    started.push(run);
    return run;
  }
  const stopRun = async (run: Started): Promise<{ code: number; message: string }> => {
    run.signals.emit("SIGTERM");
    return run.done;
  };

  /** Waits for a condition; a timeout says what the runner printed and which requests the cloud saw, so a red run explains itself. */
  async function waitFor(what: string, condition: () => boolean, ms: number): Promise<void> {
    try {
      await until(condition, ms);
    } catch {
      throw new Error(`timed out waiting for ${what}\nthe runner said:\n${logLines.slice(-40).join("\n")}\nthe cloud saw: ${cloud.seen.map((s) => s.path).slice(-20).join(" ")}\nthe helper was asked: ${JSON.stringify(calls)}`);
    }
  }
  const runOf = (runId: string) => cloud.runs.get(runId);
  const doneBody = (runId: string): Done | undefined => cloud.seen.filter((s) => s.path.endsWith(`/${runId}/done`)).map((s) => s.body as Done)[0];
  const WAIT_MS = 10 * 60_000;
  const SHORT_WAIT_MS = 5 * 60_000;
  /** The tree a correct run leaves: the seed plus the one file the agent wrote. */
  const expectedTree = (): string => {
    const dir = path.join(root, "expected");
    git("init", "-q", "-b", "main", dir);
    writeFileSync(path.join(dir, "README.md"), "hello\n");
    writeFileSync(path.join(dir, "feature.txt"), FILE_IN_GUEST);
    git("-C", dir, "add", "-A");
    return git("-C", dir, "write-tree");
  };
  const pushedTree = (): string => {
    const refs = git("--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads/fx/").split("\n").filter((r) => r !== "");
    expect(refs).toHaveLength(1);
    return git("--git-dir", remote, "rev-parse", `${refs[0]!}^{tree}`);
  };
  /** The host's raw transcripts of the CLI's output: each log line is `{kind, line}` JSON, so the CLI's own lines are read back out of it. */
  const transcripts = (): string => {
    const dir = path.join(stateDir, "logs");
    const lines: string[] = [];
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      for (const raw of readFileSync(path.join(entry.parentPath, entry.name), "utf8").split("\n")) {
        if (raw === "") continue;
        const parsed = JSON.parse(raw) as { line?: unknown };
        if (typeof parsed.line === "string") lines.push(parsed.line);
      }
    }
    return lines.join("\n");
  };
  /** The VMs this test's job made: ids in the order they were prepared, and what the REAL helper still holds of them. */
  const preparedIds = (): string[] => [...new Set(calls.filter((c) => c.verb === "prepare").map((c) => c.id))];
  const idx = (verb: Call["verb"], id: string): number => calls.findIndex((c) => c.verb === verb && c.id === id);
  async function expectNoVmLeft(): Promise<void> {
    const held = new Set((await realHelper.list()).map((e) => e.sandboxId));
    for (const id of own) {
      expect(held.has(id), `the helper still holds ${id}`).toBe(false);
      // `pgrep -f` can only be trusted where it saw this VM run; where it could not see processes of another user it says so instead of passing for nothing
      if ((seenByPgrep.get(id) ?? 0) > 0) expect(firecrackersFor(id), `a firecracker process of ${id} is still running`).toBe(0);
      else console.warn(`vmJob.real: pgrep could not see the VM ${id} while it ran; the process check is skipped for it (the helper's list is the check)`);
      // the cgroup: the kernel's own listing must show none of that name; where this user could not see one while the VM ran, the check says so instead of passing for nothing
      if ((cgroupsSeen.get(id) ?? 0) > 0) expect(cgroupDirsOf(id), `a cgroup of ${id} is still there`).toEqual([]);
      else if (vsockDirs.has(id)) console.warn(`vmJob.real: the cgroup tree showed no cgroup of ${id} while it ran; the cgroup check is skipped for it (cgroup directories named vms: ${spawnSync("find", [CGROUP_ROOT, "-maxdepth", "6", "-name", "vms"], { encoding: "utf8" }).stdout.trim() || "none readable"})`);
      // the vsock directory (it holds both egress sockets, the guest's own socket and the proxy sockets) and the jail beside it: `<jail_root>/vsock/<id>` and `<jail_root>/jails/<id>`
      const dir = vsockDirs.get(id);
      if (dir === undefined) continue; // the VM never started, so it has no directory to look for
      const jailRoot = path.dirname(path.dirname(dir));
      const seen = vsockSeenPresent.get(id) ?? new Set<string>();
      if (seen.has(dir)) expect(stateOf(dir), `the vsock directory of ${id} is still there`).toBe("gone");
      else console.warn(`vmJob.real: the vsock directory ${dir} of ${id} was not seen while the VM ran; its "gone" check is skipped`);
      for (const socket of VSOCK_NAMES) {
        const file = path.join(dir, socket);
        if (seen.has(file)) expect(stateOf(file), `${socket} of ${id} is still there`).toBe("gone");
        else console.warn(`vmJob.real: ${socket} of ${id} was not seen while the VM ran; its "gone" check is skipped`);
      }
      const jail = stateOf(path.join(jailRoot, "jails", id));
      if (jail === "unreadable") console.warn(`vmJob.real: the jail directory of ${id} is below a directory this user may not search; only the helper's list says it is gone`);
      else expect(jail, `the jail directory of ${id} is still there`).toBe("gone");
    }
  }
  /** The runner's inventory block (the `sandboxes` of a claim) names none of this test's VMs in the last claim that carried one. The runner's live table is internal to `run`; this is what the cloud was told. */
  function expectNoInventoryRow(): void {
    const inventories = cloud.seen.filter((s) => s.path.endsWith("/claim")).map((s) => (s.body as { sandboxes?: Array<{ name: string }> } | undefined)?.sandboxes).filter((b): b is Array<{ name: string }> => b !== undefined);
    const last = inventories[inventories.length - 1] ?? [];
    for (const id of own) {
      // control: some claim listed this VM while it ran; without that, "not listed now" cannot tell removed from never listed
      if (!inventories.some((b) => b.some((r) => r.name === id))) {
        console.warn(`vmJob.real: no claim ever listed ${id} in its inventory; the inventory check is skipped for it`);
        continue;
      }
      expect(last.map((r) => r.name), `the runner's last inventory still lists ${id}`).not.toContain(id);
    }
  }
  function expectNoToken(): void {
    const needle = Buffer.from(sentinel);
    // control: the search finds a token that is there, so "none found" below means something
    const planted = path.join(root, "planted.txt");
    writeFileSync(planted, `x${sentinel}x`);
    expect(filesHolding(root, needle)).toEqual([planted]);
    rmSync(planted);
    expect(filesHolding(root, needle), "a file under the runner's home, state, logs or workspaces holds the token").toEqual([]);
    expect(logLines.join("\n")).not.toContain(sentinel);
    expect(JSON.stringify(cloud.seen)).not.toContain(sentinel);
    expect(JSON.stringify([...cloud.runs.values()])).not.toContain(sentinel);
  }

  it("26a: the job is claimed, the CLI runs in the guest with the token, the commit comes out and is pushed, the check runs in a FRESH VM that has none of the agent's files (26b), the job ends, no VM is left", async () => {
    cloud.enqueue(queuedJob({ check: check(`echo probe-in-check-vm=$(test -e ${AGENT_PROBE} && echo present || echo absent); test -f feature.txt && echo workspace-has-the-agents-commit`) }));
    const run = startRun(partsFor(scriptFor()));
    await waitFor("the job to be done", () => [...cloud.runs.values()].some((r) => r.doneReply !== undefined), WAIT_MS);
    const runId = [...cloud.runs.keys()][0]!;
    const body = doneBody(runId)!;
    // the check passed, in the guest, on the agent's commit, with the probe the agent made in its own VM absent
    expect(body.check).toMatchObject({ exit_code: 0, timed_out: false });
    expect(body.check?.summary).toContain("probe-in-check-vm=absent");
    expect(body.check?.summary).toContain("workspace-has-the-agents-commit");
    expect(runOf(runId)!.endedBy).toBeUndefined();
    // the agent ran in a guest: the host transcript holds what the CLI reported about its own environment
    const said = transcripts();
    expect(said).toContain("cli_sees=match");
    expect(said).toContain("scrub_pin=True");
    expect(said).toContain("child_sees=absent");
    expect(said).toContain("probe_written=True");
    expect(said).toContain("workdir=/vercel/sandbox/work");
    // the host holds exactly the tree the agent built: the seed and its one file
    expect(pushedTree()).toBe(expectedTree());
    // two VMs, the second made after the first was ended
    const [agentVm, checkVm, ...more] = preparedIds();
    expect(agentVm).toBeDefined();
    expect(checkVm).toBeDefined();
    expect(more).toEqual([]);
    expect(idx("destroy", agentVm!)).toBeGreaterThan(-1);
    expect(idx("destroy", agentVm!)).toBeLessThan(idx("prepare", checkVm!));
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    await expectNoVmLeft();
    expectNoInventoryRow();
    expectNoToken();
  }, 780_000);

  it("26b: a check that fails in the fresh VM ends the job on the host with the check's own closed result, and the branch is still pushed", async () => {
    cloud.enqueue(queuedJob({ check: check("echo checked-in-the-fresh-vm; echo probe=$(test -e " + AGENT_PROBE + " && echo present || echo absent); exit 3") }));
    const run = startRun(partsFor(scriptFor()));
    await waitFor("the job to be done", () => [...cloud.runs.values()].some((r) => r.doneReply !== undefined), WAIT_MS);
    const runId = [...cloud.runs.keys()][0]!;
    expect(runOf(runId)!.endedBy).toMatchObject({ type: "run_ended", reason: "check_failed" });
    const body = doneBody(runId)!;
    expect(body.check).toMatchObject({ exit_code: 3, timed_out: false });
    expect(body.check?.summary).toContain("checked-in-the-fresh-vm");
    expect(body.check?.summary).toContain("probe=absent");
    expect(pushedTree()).toBe(expectedTree());
    expect(preparedIds()).toHaveLength(2);
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    await expectNoVmLeft();
    expectNoToken();
  }, 780_000);

  it("a helper that refuses to create the VM ends the job with the closed setup reason, runs nothing, and leaves no VM", async () => {
    injection.prepare = true;
    // what the REAL helper holds now: the refused call never reaches it, so nothing may be added to this list by the run
    const heldBefore = new Set((await realHelper.list()).map((e) => e.sandboxId));
    cloud.enqueue(queuedJob({ check: check("true") }));
    const run = startRun(partsFor(scriptFor()));
    await waitFor("the run to be ended", () => [...cloud.runs.values()].some((r) => r.endedBy !== undefined), SHORT_WAIT_MS);
    const runId = [...cloud.runs.keys()][0]!;
    const end = endOfFailure("sandbox_unavailable")!;
    expect(runOf(runId)!.endedBy).toMatchObject({ type: "run_ended", reason: end.reason, ...(end.detail === undefined ? {} : { detail: end.detail }) });
    expect(doneBody(runId)).toBeUndefined();
    expect(calls.filter((c) => c.verb === "start")).toEqual([]);
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    // a VM another test file in this directory made meanwhile is not ours and goes away on its own; one this run leaked would stay
    const added = (): Promise<string[]> => realHelper.list().then((l) => l.map((e) => e.sandboxId).filter((id) => !heldBefore.has(id)));
    const give_up = Date.now() + 120_000;
    let extra = await added();
    while (extra.length > 0 && Date.now() < give_up) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      extra = await added();
    }
    expect(extra, "the real helper holds VMs it did not hold before the refused create").toEqual([]);
    await expectNoVmLeft();
    expectNoToken();
  }, 420_000);

  it("a VM that cannot be ended is reported as vm_teardown_incomplete, and the job is not a success", async () => {
    injection.destroy = true;
    cloud.enqueue(queuedJob({ check: check("true") }));
    const run = startRun(partsFor(scriptFor()));
    await waitFor("the run to be ended", () => [...cloud.runs.values()].some((r) => r.endedBy !== undefined), WAIT_MS);
    const runId = [...cloud.runs.keys()][0]!;
    expect(runOf(runId)!.endedBy).toMatchObject({ type: "run_ended" });
    expect(runOf(runId)!.doneReply).toBeUndefined();
    const said = logLines.join("\n");
    expect(said).toContain("microVM teardown incomplete");
    expect(said).toContain("microVM step failed (stop_agent)");
    // the agent had run and its VM was refused its end: the leftover is the one the reaper would take
    expect(preparedIds()).toHaveLength(1);
    // the VM really is still there: that is what "incomplete" means. It is ended now, through the real helper, and only then is "no VM left" asserted.
    injection.destroy = false;
    const [leftover] = preparedIds();
    expect((await realHelper.list()).some((e) => e.sandboxId === leftover)).toBe(true);
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    await realHelper.destroy(leftover!).catch(() => undefined); // fx-swallow-ok: the run's own shutdown may already have ended it, which is the wanted state
    await expectNoVmLeft();
    expectNoToken();
  }, 780_000);

  it("a stop (SIGTERM) while the agent runs ends the job and its VM: nothing is left", async () => {
    cloud.enqueue(queuedJob({ task: { kind: "implement", prompt: `${HANG}\n`, prompt_sha256: sha256Text(`${HANG}\n`) }, check: check("true") }));
    const run = startRun(partsFor(scriptFor()));
    // the CLI is running in the guest once its first line has reached the host's transcript
    await until(() => {
      try {
        return transcripts().includes('"subtype":"init"');
      } catch {
        // fx-swallow-ok: the log directory is not there yet, which is "not running yet"
        return false;
      }
    }, SHORT_WAIT_MS);
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    // the cloud was told why the run ended: the runner was stopped (that report is best-effort, so it is waited for, bounded)
    const runId = [...cloud.runs.keys()][0]!;
    await waitFor("the cloud to be told the run ended", () => runOf(runId)?.endedBy !== undefined, 30_000);
    expect(runOf(runId)!.endedBy).toMatchObject({ type: "run_ended", reason: "runner_shutdown" });
    expect(preparedIds()).toHaveLength(1);
    await expectNoVmLeft();
    expectNoToken();
  }, 780_000);

  /** The tests of D#587 B-5b-3c-v: what the first file left open of criterion 26a. */
  const isDone = (): boolean => [...cloud.runs.values()].some((r) => r.doneReply !== undefined);
  const isEnded = (): boolean => [...cloud.runs.values()].some((r) => r.endedBy !== undefined);
  /** One event as it is compared between engines: what it says, never its number, time or duration. */
  const shapeOf = (e: { type: string; stage?: string; tool_name?: string; activity?: unknown; engine_version?: string; reason?: string; detail?: string; exit_code?: number; usage?: unknown }): string =>
    JSON.stringify([e.type, e.stage, e.tool_name, e.activity, e.engine_version, e.reason, e.detail, e.exit_code, e.usage]);

  it("26a (engines): the same scripted job on os_sandbox and on microvm pushes the same tree and reports the same events in the same order", async (ctx) => {
    const osTools = bwrapUsable() ? osToolbin(root, scriptFor({ os: true }), fake.binary) : undefined;
    if (osTools === undefined) {
      const probe = onPath("bwrap") === undefined ? undefined : spawnSync(onPath("bwrap") as string, ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "true"], { encoding: "utf8" });
      console.warn(`vmJob.real: the OS-sandbox side of the engine comparison cannot run here, so the comparison is SKIPPED. Tools: ${["bwrap", "socat", "git", "sh", "env", "python3"].map((t) => `${t}=${onPath(t) ?? "missing"}`).join(" ")}; bwrap probe: ${probe === undefined ? "not run" : `exit ${probe.status}: ${probe.stderr.trim()}`}`);
      return ctx.skip();
    }
    const job = () => queuedJob({ check: check("test -f feature.txt") });
    // the VM side
    cloud.enqueue(job());
    const vmRun = startRun(partsFor(scriptFor()));
    await waitFor("the VM job to be done", isDone, WAIT_MS);
    const vmId = [...cloud.runs.keys()][0]!;
    const vmTree = pushedTree();
    const vmEvents = runOf(vmId)!.events.map(shapeOf);
    expect(await stopRun(vmRun)).toMatchObject({ code: 0 });
    await expectNoVmLeft();
    // the OS-sandbox side: the same job, a fresh repository, the engine setting flipped, and a runner started without the VM parts
    remote = seedRemote("remote-os");
    setSetting(stateDir, "sandbox_engine", "os_sandbox");
    cloud.enqueue(job());
    const osRun = startRun(undefined, { searchPath: osTools });
    await waitFor("the OS-sandbox job to be done", () => [...cloud.runs.values()].filter((r) => r.doneReply !== undefined).length === 2, SHORT_WAIT_MS);
    const osId = [...cloud.runs.keys()].find((id) => id !== vmId)!;
    const osTree = pushedTree();
    const osEvents = runOf(osId)!.events.map(shapeOf);
    expect(await stopRun(osRun)).toMatchObject({ code: 0 });
    expect(runOf(osId)!.endedBy).toBeUndefined();
    // a comparison of two empty lists would be the same on any two engines
    expect(vmEvents.length).toBeGreaterThan(0);
    expect(osTree).toBe(expectedTree());
    expect(osTree).toBe(vmTree);
    expect(osEvents).toEqual(vmEvents);
    expectNoToken();
  }, 1_200_000);

  it("26a (disk): the token is on no disk-backed file of the guest (found by a search as the guest's root, with a planted control), and nothing of the VMs is left on the host", async () => {
    cloud.enqueue(queuedJob({ task: { kind: "implement", prompt: `${DISKSCAN}\n`, prompt_sha256: sha256Text(`${DISKSCAN}\n`) }, check: check("true") }));
    const run = startRun(partsFor(scriptFor({ scan: true })));
    await waitFor("the job to be done", isDone, 14 * 60_000);
    const said = transcripts();
    // the token was in the CLI's environment, so the scan ran in a guest that held it; the control file was found and nothing else was
    expect(said).toContain("cli_sees=match");
    // the guest's disks: none is writable (so there is nowhere on a disk to put the token), and a search of every file on them finds none
    expect(said).toContain("disk_writable=none");
    expect(said).toContain("disk_scan=clean");
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    await expectNoVmLeft();
    expectNoToken();
  }, 1_000_000);

  it("a check that outlives its time limit ends with the timeout outcome, the branch is still pushed, and both VMs are gone", async () => {
    cloud.enqueue(queuedJob({ check: { argv: ["sh", "-c", "echo started-and-will-not-finish; sleep 900"], dev_shell: false, timeout_s: 60 } }));
    const run = startRun(partsFor(scriptFor()));
    await waitFor("the job to be done", isDone, WAIT_MS);
    const runId = [...cloud.runs.keys()][0]!;
    const body = doneBody(runId)!;
    expect(body.check).toMatchObject({ exit_code: null, timed_out: true });
    expect(runOf(runId)!.endedBy).toMatchObject({ type: "run_ended", reason: "check_failed" });
    expect(pushedTree()).toBe(expectedTree());
    expect(preparedIds()).toHaveLength(2);
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    await expectNoVmLeft();
    expectNoToken();
  }, 780_000);

  it("a guest that never answers ends the job with the closed setup reason, runs nothing, and the VM the helper started is ended", async () => {
    cloud.enqueue(queuedJob({ check: check("true") }));
    const run = startRun(partsFor(scriptFor(), { silentGuest: true }));
    await waitFor("the run to be ended", isEnded, SHORT_WAIT_MS);
    const runId = [...cloud.runs.keys()][0]!;
    const end = endOfFailure("sandbox_unavailable")!;
    expect(runOf(runId)!.endedBy).toMatchObject({ type: "run_ended", reason: end.reason, ...(end.detail === undefined ? {} : { detail: end.detail }) });
    expect(doneBody(runId)).toBeUndefined();
    // the VM really was started (so there was something that never answered), and only one was ever made: the check VM is never reached
    expect(calls.filter((c) => c.verb === "start")).toHaveLength(1);
    expect(preparedIds()).toHaveLength(1);
    expect(await stopRun(run)).toMatchObject({ code: 0 });
    await expectNoVmLeft();
    expectNoToken();
  }, 420_000);
});
