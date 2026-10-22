import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Check, Job, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed, type GitTicketResult } from "../../src/daemon/client.js";
import { createBaseFile, createCheckStep, createVcsState, type CheckLaunch } from "../../src/daemon/checkStep.js";
import type { GitCapture } from "../../src/daemon/git.js";
import { createGitPathA } from "../../src/daemon/gitPathA.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { createNixShell, type NixDetail, type NixSkip } from "../../src/daemon/nixShell.js";
import { runCapture, runInstall } from "../../src/engines/claude/capture.js";
import { NIX_FLAKE_CHANGED_NOTE } from "../../src/job/prompt.js";
import { generateRunnerKey } from "../../src/keys.js";
import { originHash } from "../../src/keyring.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxHandle, SandboxPort } from "../../src/sandbox/port.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { startRelay, type Relay } from "../helpers/relayFixture.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/**
 * D#6 R-CHK-2b: a verified-mode job (git path A) runs the repository's approved check exactly as a local one (path B) does. Everything here is real except the agent and
 * the sandbox tool: the real path A against a strict relay with `git http-backend` behind it, the real check step on real processes, the real merge-base pin and base-file
 * read from the mirror path A synced. The sandbox's own launch (bubblewrap, seccomp, read-only binds) is the one `checkLaunch` the handler holds for both paths, proved on
 * real bubblewrap in hostSandboxCheck.bwrap.test.ts; here it starts the vector directly and records the sandbox it was asked for.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CLOUD = "https://cloud.example.test";
const CHECK: Check = { argv: ["bash", "scripts/check.sh"], dev_shell: false, timeout_s: 60 };

let cloud: StrictRunnerCloud;
let root: string;
let home: string;
let upstream: string;
let relay: Relay;
let ticket: string;
let caFile: string;

const SETUP_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
});
const sh = (...args: string[]): string => execFileSync("git", args, { env: SETUP_ENV(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The default branch's check: what the cloud approved. The agent's branch replaces it with one that always passes; the pin must undo that for the run. */
const BASE_CHECK = (body: string): string => `#!/bin/sh\necho base check ran\n${body}\n`;
const AGENT_CHECK = "#!/bin/sh\necho agent check ran\nexit 0\n";

/** D#6 R-CHK-2c: a flake whose dev shell is told apart by the name in its first line (the stand-in `nix` reads it from the commit it is asked to build). */
const FLAKE = (shell: string): string => `# shell: ${shell}\n{ outputs = { self }: {}; }\n`;
const LOCK = JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: {} } } });
const ALLOWANCES = { entries: [{ kind: "domain" as const, value: "registry.npmjs.org", access: "connect" as const, reason: "install" }], command_timeout_s: 600 };
const STORE_HASH = "a".repeat(32);

function seedUpstream(checkBody: string, shell?: string): void {
  upstream = path.join(root, "projects", "acme", "widgets.git");
  mkdirSync(path.dirname(upstream), { recursive: true });
  sh("init", "--bare", "-b", "main", upstream);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  mkdirSync(path.join(seed, "scripts"));
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  writeFileSync(path.join(seed, "scripts", "check.sh"), BASE_CHECK(checkBody));
  chmodSync(path.join(seed, "scripts", "check.sh"), 0o755);
  if (shell !== undefined) {
    writeFileSync(path.join(seed, "flake.nix"), FLAKE(shell));
    writeFileSync(path.join(seed, "flake.lock"), LOCK);
    sh("-C", seed, "add", "flake.nix", "flake.lock");
  }
  sh("-C", seed, "add", "README.md", "scripts/check.sh");
  sh("-C", seed, "commit", "-q", "-m", "first");
  sh("-C", seed, "push", "-q", upstream, "main");
}

beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-checkpatha-"));
  home = path.join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  ticket = ["hdr", "claims", "sig"].map((part) => Buffer.from(`${part}-${randomBytes(24).toString("hex")}`).toString("base64url")).join(".");
  mkdirSync(path.join(root, "not-the-temp-dir"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await relay?.close();
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

/**
 * D#6 R-CHK-2c: the real Nix step (`createNixShell`) on real processes, with a stand-in `nix` and `bwrap` (as in jobHandlerNix.test.ts). The stand-in `nix`
 * builds nothing: asked for a dev shell of `git+file://<mirror>?rev=<sha>`, it reads `flake.nix` at that commit from that mirror with the real git and names
 * the shell after it, so which flake the shell came from is read off the output, not off a flag. Every call is logged.
 */
function writeNixStandIns(): void {
  const gitBin = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(root, "nix"),
    `#!/bin/sh
echo "$@" >> "${root}/nix-calls.log"
case "$*" in
  *"config show trusted-users"*) echo root; exit 0;;
  *print-dev-env*)
    for a in "$@"; do case "$a" in git+file://*) ref="$a";; esac; done
    dir="\${ref#git+file://}"; dir="\${dir%%\\?*}"; rev="\${ref##*rev=}"
    name=$("${gitBin}" --git-dir="$dir" show "$rev:flake.nix" | sed -n 's/^# shell: //p')
    [ -n "$name" ] || exit 7
    echo "{\\"variables\\":{\\"PATH\\":{\\"type\\":\\"exported\\",\\"value\\":\\"/nix/store/${STORE_HASH}-$name/bin\\"}}}"; exit 0;;
esac
exit 9
`,
  );
  chmodSync(path.join(root, "nix"), 0o755);
  writeFileSync(
    path.join(root, "bwrap"),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in --) shift; break;; --setenv|--ro-bind) shift 3;; --proc|--dev|--tmpfs|--dir) shift 2;; *) shift;; esac
done
exec "$@"
`,
  );
  chmodSync(path.join(root, "bwrap"), 0o755);
}
const nixCalls = (): string[] => (existsSync(path.join(root, "nix-calls.log")) ? readFileSync(path.join(root, "nix-calls.log"), "utf8").trim().split("\n") : []);
const devEnvRevs = (): string[] => nixCalls().filter((c) => c.includes("print-dev-env")).map((c) => /\?rev=([0-9a-f]+)/.exec(c)?.[1] ?? "");

async function rig(checkBody: string, over: { wired?: boolean; shell?: string; nix?: "standin" | "not_installed"; agentEditsFlake?: boolean } = {}) {
  seedUpstream(checkBody, over.shell);
  if (over.nix !== undefined) writeNixStandIns();
  const skips: NixSkip[] = [];
  const details: NixDetail[] = [];
  const prompts: string[] = [];
  /** The dev shell each agent start was given (the grant's `nixEnv`), as the real host sandbox keeps it for the check. */
  const shells: Array<Readonly<Record<string, string>> | undefined> = [];
  relay = await startRelay({ projectRoot: path.join(root, "projects"), ticket, owner: "acme", name: "widgets" });
  caFile = path.join(root, "ca.pem");
  writeFileSync(caFile, relay.caPem);
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const capture: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, command, args, { ...env, GIT_SSL_CAINFO: caFile }, timeoutMs, undefined, 2048);
  const captureLarge: GitCapture = (command, args, env, timeoutMs) => runCapture(spawn, command, args, env, timeoutMs, 8 * 1024 * 1024, 2048);
  const gitA = createGitPathA({
    capture, mirrorsRoot: path.join(root, "cache", "mirrors"), stateDir: path.join(root, "state"), cloudOrigin: CLOUD, platform: "linux",
    mintTicket: async (): Promise<GitTicketResult> => ({ kind: "ticket", ticket, expiresAt: new Date(Date.now() + 300_000).toISOString(), proxyOrigin: relay.origin }),
    pinned: { [originHash(CLOUD)!]: originHash(relay.origin)! }, tmpDir: path.join(root, "not-the-temp-dir"), statfs: () => ({ type: 0xef53 }),
  });
  const gitB = fakeGitPath();
  const agentSandboxes: string[] = [];
  const launchedIn: string[] = [];
  const port: SandboxPort = {
    async createSandbox(opts) { agentSandboxes.push(opts.sandboxName); return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      // The agent: replaces the check with one that always passes, and commits it on the run branch.
      const workdir = opts.workdir;
      if (workdir === undefined) throw new Error("the agent is always started in its workspace");
      prompts.push(opts.prompt);
      shells.push(opts.allowances?.nixEnv);
      writeFileSync(path.join(workdir, "scripts", "check.sh"), AGENT_CHECK);
      sh("-C", workdir, "add", "scripts/check.sh");
      if (over.agentEditsFlake === true) {
        writeFileSync(path.join(workdir, "flake.nix"), FLAKE("agent-shell"));
        writeFileSync(path.join(workdir, "flake.lock"), JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: {} } }, edited: true }));
        sh("-C", workdir, "add", "flake.nix", "flake.lock");
      }
      sh("-C", workdir, "commit", "-q", "-m", "make the check pass");
      const event: NormalizedEvent = { runId: opts.runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } };
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()), git: gitB, gitA, events: createEventRelay(),
    recordSession: async () => {}, heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    ...(over.nix === undefined ? {} : {
      nix: createNixShell({
        nixBin: over.nix === "not_installed" ? undefined : path.join(root, "nix"), bwrapBin: path.join(root, "bwrap"), viewFs: { exists: () => true, isDir: () => true, isFile: () => false, list: () => [] },
        capture: (command, args, env, timeoutMs) => runCapture(spawn, command, args, env, timeoutMs, 1024 * 1024, 2048), dataDir: path.join(root, "nix-data"), storeExists: () => true,
        identity: async () => ({ user: "runner", groups: ["users"] }),
      }),
      onNixSkip: (skip: NixSkip) => skips.push(skip),
      onNixDetail: (detail: NixDetail) => details.push(detail),
    }),
    ...(over.wired === false ? {} : {
      checkStep: createCheckStep({ capture: (command, args, env, cwd, timeoutMs, tail, signal, feed) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed), now: () => new Date(), vcsState: createVcsState(captureLarge, {}) }),
      baseFile: createBaseFile(captureLarge, {}),
      // A dev-shell check gets the shell the agent's sandbox was started with, in front of the host PATH (the real merge is HostSandbox.checkLaunch's, proved there).
      checkLaunch: (target: SandboxHandle, argv: readonly string[], devShell: boolean): CheckLaunch => {
        launchedIn.push(target.sandboxName);
        const shell = shells.at(-1);
        return { tool: argv[0]!, args: argv.slice(1), env: devShell && shell !== undefined ? { ...SETUP_ENV(), PATH: `${shell.PATH}:${SETUP_ENV().PATH}` } : SETUP_ENV() };
      },
      checkHome: home,
    }),
  };
  return {
    gitB, agentSandboxes, launchedIn, client, skips, details, prompts, shells, handle: createJobHandler(deps),
    async claim(check: Check | null = CHECK, extra: Partial<Job> = {}): Promise<Claimed> {
      cloud.enqueue(signRaw(jobFor({ mode: "verified", ...(check === null ? {} : { check }), ...extra })) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

const bodies = (suffix: string): Array<Record<string, unknown>> => cloud.seen.filter((s) => s.path.endsWith(suffix)).map((s) => s.body as Record<string, unknown>);
const runEnded = () => bodies("/events").flatMap((b) => (b.events as Array<Record<string, unknown>>).filter((e) => e.type === "run_ended"));
const branchOf = (claimed: Claimed): string => `fx/${claimed.runId}-g${claimed.leaseGeneration}`;
const upstreamFile = (ref: string, file: string): string | null => {
  try {
    return sh("-C", upstream, "show", `${ref}:${file}`);
  } catch {
    return null;
  }
};

describe("a verified-mode job with an approved check (path A)", () => {
  it("runs the default branch's check, not the branch's, in the agent's sandbox, records the result on done, and pushes the branch with its own file given back", async () => {
    const r = await rig("exit 0");
    const claimed = await r.claim();
    const result = await r.handle(claimed);
    expect(result.status).toBe("completed");
    // Path A did the git work; path B was never asked.
    expect(r.gitB.calls).toEqual([]);
    // The check was launched under the sandbox the agent ran in.
    expect(r.launchedIn).toEqual(r.agentSandboxes);
    expect(r.launchedIn).toHaveLength(1);
    const check = bodies("/done")[0]!.check as Record<string, unknown>;
    expect(check).toMatchObject({ exit_code: 0, timed_out: false });
    expect(check.summary).toContain("base check ran");
    expect(check.summary).not.toContain("agent check ran");
    expect(check.summary).toContain("check files changed by this branch: scripts/check.sh");
    expect(runEnded()).toEqual([]);
    // The run branch holds the agent's commit, with the agent's own check file (given back after the run, never replaced by the base copy).
    expect(upstreamFile(branchOf(claimed), "scripts/check.sh")).toBe(AGENT_CHECK);
  });

  it("a failing default-branch check fails the run check_failed, even though the branch's own check would pass", async () => {
    const r = await rig("exit 4");
    const claimed = await r.claim();
    await r.handle(claimed);
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: 4, timed_out: false });
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed" })]);
    expect(upstreamFile(branchOf(claimed), "scripts/check.sh")).toBe(AGENT_CHECK);
  });

  it("a protected path the check changes fails the check even at exit 0, is put back, and is never committed or pushed", async () => {
    const r = await rig("printf 'registry=https://evil.example.test/\\n' > .npmrc\nprintf 'TOKEN=x\\n' > .env.local\nexit 0");
    const claimed = await r.claim();
    await r.handle(claimed);
    const check = bodies("/done")[0]!.check as Record<string, unknown>;
    expect(check).toMatchObject({ exit_code: 0 });
    expect(check.summary).toMatch(/the check changed paths it may not \(put back where possible\): .*\.env\.local/);
    expect(check.summary).toMatch(/the check changed paths it may not \(put back where possible\): .*\.npmrc/);
    expect(check.summary).not.toContain("not put back");
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed" })]);
    expect(upstreamFile(branchOf(claimed), ".npmrc")).toBeNull();
    expect(upstreamFile(branchOf(claimed), ".env.local")).toBeNull();
    // The workspace itself no longer holds them either (it is kept for a fix round's resume).
    const workspace = path.join(root, "work", claimed.runId);
    expect(existsSync(path.join(workspace, "scripts", "check.sh"))).toBe(true);
    expect(existsSync(path.join(workspace, ".npmrc"))).toBe(false);
    expect(existsSync(path.join(workspace, ".env.local"))).toBe(false);
  });

  it("a check that moves the version-control state fails by name even at exit 0", async () => {
    // Under the real sandbox the folder is bound read-only and this commit cannot be made (hostSandboxCheck.bwrap.test.ts); the launch here has no binds, so this is the
    // check step's own second layer: the before/after digest of HEAD, every ref and the index.
    const r = await rig("echo sneaky > sneaky.txt\ngit add sneaky.txt\ngit commit -q -m sneaky\nexit 0");
    const claimed = await r.claim();
    await r.handle(claimed);
    const check = bodies("/done")[0]!.check as Record<string, unknown>;
    expect(check).toMatchObject({ exit_code: 0 });
    expect(check.summary).toContain("not put back: .git");
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed" })]);
  });
});

describe("a verified-mode job without a usable check behaves as on path B", () => {
  it("a job that carries no check runs no check, adds no note, and done carries none", async () => {
    const r = await rig("echo should-not-run > ran.txt\nexit 1");
    const claimed = await r.claim(null);
    expect((await r.handle(claimed)).status).toBe("completed");
    expect(r.launchedIn).toEqual([]);
    expect(bodies("/done")[0]).not.toHaveProperty("check");
    expect(runEnded()).toEqual([]);
    expect(upstreamFile(branchOf(claimed), "ran.txt")).toBeNull();
  });

  it("a runner with no check step wired fails the check: it is never passed by default", async () => {
    const r = await rig("exit 0", { wired: false });
    await r.handle(await r.claim());
    expect(r.launchedIn).toEqual([]);
    expect(bodies("/done")[0]!.check).toMatchObject({ exit_code: null, timed_out: false, duration_ms: 0 });
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed" })]);
  });

  it("a check that needs the dev shell, on a runner that built none, is not run and says check_no_dev_shell", async () => {
    const r = await rig("exit 0");
    await r.handle(await r.claim({ ...CHECK, dev_shell: true }));
    expect(r.launchedIn).toEqual([]);
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed", detail: "check_no_dev_shell" })]);
  });

  it("a check key the cloud did not sign is refused with the job: nothing runs", async () => {
    const r = await rig("exit 0");
    // Signed without a check, then given one: the signature no longer covers the job.
    const signed = signRaw(jobFor({ mode: "verified" })) as { job: Record<string, unknown>; signature: string };
    cloud.enqueue({ job: { ...signed.job, check: CHECK }, signature: signed.signature } as never);
    const claimed = await r.client.claim();
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    expect((await r.handle(claimed)).status).toBe("refused");
    expect(r.agentSandboxes).toEqual([]);
    expect(r.launchedIn).toEqual([]);
    expect(relay.requests).toEqual([]);
    expect(bodies("/done")).toEqual([]);
  });
});

describe("a verified-mode job whose check needs the dev shell (path A, D#6 R-CHK-2c)", () => {
  /**
   * The check prints the first entry of the PATH it was started with: the dev shell's bin, which the launch puts in front. Only that entry, never the whole PATH:
   * done keeps the last 4096 bytes of output, and a host PATH (under `nix develop` it runs to several KB) would push "base check ran" and the shell's entry out of it.
   */
  const SHELL_CHECK = 'echo "check PATH starts: ${PATH%%:*}"\nexit 0';
  const DEV_CHECK: Check = { ...CHECK, dev_shell: true };
  /** Commits `files` on `branch` of the upstream (cut from `from` when given) and returns the new tip. */
  function upstreamFiles(branch: string, files: Record<string, string>, from?: string): string {
    const clone = path.join(root, `clone-${randomBytes(6).toString("hex")}`);
    sh("clone", "-q", upstream, clone);
    if (from !== undefined) sh("-C", clone, "checkout", "-q", "-b", branch, from);
    else sh("-C", clone, "checkout", "-q", branch);
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(clone, file), text);
    sh("-C", clone, "add", ...Object.keys(files));
    sh("-C", clone, "commit", "-q", "-m", Object.keys(files).join(" "));
    sh("-C", clone, "push", "-q", upstream, branch);
    return sh("-C", clone, "rev-parse", "HEAD").trim();
  }

  it("runs in the shell built from the default branch's flake, at the run's start commit, even when the agent rewrites flake.nix and flake.lock", async () => {
    const r = await rig(SHELL_CHECK, { shell: "default-shell", nix: "standin", agentEditsFlake: true });
    const start = sh("-C", upstream, "rev-parse", "main").trim();
    const claimed = await r.claim(DEV_CHECK, { sandbox_allowances: ALLOWANCES });
    expect((await r.handle(claimed)).status).toBe("completed");
    expect(r.skips).toEqual([]);
    // One build, of the default branch's commit the run started from, through the mirror path A synced; the agent's sandbox got that shell.
    expect(devEnvRevs()).toEqual([start]);
    expect(r.shells).toEqual([{ PATH: `/nix/store/${STORE_HASH}-default-shell/bin` }]);
    expect(r.launchedIn).toEqual(r.agentSandboxes);
    const check = bodies("/done")[0]!.check as Record<string, unknown>;
    expect(check).toMatchObject({ exit_code: 0, timed_out: false });
    expect(check.summary).toContain("base check ran");
    expect(check.summary).toContain(`${STORE_HASH}-default-shell/bin`);
    expect(check.summary).not.toContain("agent-shell");
    expect(runEnded()).toEqual([]);
    // The agent's flake edit is on its branch, untouched; it was never built.
    expect(upstreamFile(branchOf(claimed), "flake.nix")).toBe(FLAKE("agent-shell"));
    expect(nixCalls().join("\n")).not.toContain(sh("-C", upstream, "rev-parse", branchOf(claimed)).trim());
  });

  it("a fix round on a branch that edited flake.nix and flake.lock gets the merge-base's shell, never the branch's or the moved-on tip's, and is told so", async () => {
    const r = await rig(SHELL_CHECK, { shell: "default-shell", nix: "standin" });
    const forkPoint = sh("-C", upstream, "rev-parse", "main").trim();
    const parent = "7c7c7c7c-7a43-4d5e-8a77-0f0f0f0f0f0f";
    const prior = `fx/${parent}-g1`;
    const priorTip = upstreamFiles(prior, { "flake.nix": FLAKE("agent-shell"), "flake.lock": JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: {} } }, edited: true }) }, forkPoint);
    upstreamFiles("main", { "flake.nix": FLAKE("later-shell") }); // the default branch moves on after the branch was cut
    const claimed = await r.claim(DEV_CHECK, { sandbox_allowances: ALLOWANCES, continues: { parent_run_id: parent, session_id: null, branch: prior } });
    expect((await r.handle(claimed)).status).toBe("completed");
    expect(r.skips).toEqual([]);
    expect(devEnvRevs()).toEqual([forkPoint]);
    expect(nixCalls().join("\n")).not.toContain(priorTip);
    expect(r.details).toEqual(["nix_from_default_branch", "nix_flake_changed"]);
    expect(r.prompts[0]).toContain(NIX_FLAKE_CHANGED_NOTE);
    const check = bodies("/done")[0]!.check as Record<string, unknown>;
    expect(check).toMatchObject({ exit_code: 0 });
    expect(check.summary).toContain(`${STORE_HASH}-default-shell/bin`);
    expect(check.summary).not.toContain("agent-shell");
    expect(check.summary).not.toContain("later-shell");
    expect(runEnded()).toEqual([]);
  });

  it("allowances still gate the build: a job without signed allowances starts no nix at all, and its dev-shell check ends check_no_dev_shell", async () => {
    const r = await rig(SHELL_CHECK, { shell: "default-shell", nix: "standin" });
    await r.handle(await r.claim(DEV_CHECK));
    expect(nixCalls()).toEqual([]);
    expect(r.skips).toEqual([]);
    expect(r.shells).toEqual([undefined]);
    expect(r.launchedIn).toEqual([]);
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed", detail: "check_no_dev_shell" })]);
  });

  it("no flake on the default branch: no dev shell, and the check is not run but ends check_no_dev_shell", async () => {
    const r = await rig(SHELL_CHECK, { nix: "standin" });
    await r.handle(await r.claim(DEV_CHECK, { sandbox_allowances: ALLOWANCES }));
    expect(r.skips).toEqual(["nix_no_flake"]);
    expect(devEnvRevs()).toEqual([]);
    expect(r.launchedIn).toEqual([]);
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed", detail: "check_no_dev_shell" })]);
  });

  it("no nix on the machine: no dev shell, and the check is not run but ends check_no_dev_shell", async () => {
    const r = await rig(SHELL_CHECK, { shell: "default-shell", nix: "not_installed" });
    await r.handle(await r.claim(DEV_CHECK, { sandbox_allowances: ALLOWANCES }));
    expect(r.skips).toEqual(["nix_not_installed"]);
    expect(nixCalls()).toEqual([]);
    expect(r.launchedIn).toEqual([]);
    expect(runEnded()).toEqual([expect.objectContaining({ reason: "check_failed", detail: "check_no_dev_shell" })]);
  });
});
