import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Check, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed, type GitTicketResult } from "../../src/daemon/client.js";
import { createBaseFile, createCheckStep, createVcsState, type CheckLaunch } from "../../src/daemon/checkStep.js";
import type { GitCapture } from "../../src/daemon/git.js";
import { createGitPathA } from "../../src/daemon/gitPathA.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { runCapture, runInstall } from "../../src/engines/claude/capture.js";
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

function seedUpstream(checkBody: string): void {
  upstream = path.join(root, "projects", "acme", "widgets.git");
  mkdirSync(path.dirname(upstream), { recursive: true });
  sh("init", "--bare", "-b", "main", upstream);
  const seed = path.join(root, "seed");
  sh("init", "-b", "main", seed);
  mkdirSync(path.join(seed, "scripts"));
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  writeFileSync(path.join(seed, "scripts", "check.sh"), BASE_CHECK(checkBody));
  chmodSync(path.join(seed, "scripts", "check.sh"), 0o755);
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

async function rig(checkBody: string, over: { wired?: boolean } = {}) {
  seedUpstream(checkBody);
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
      writeFileSync(path.join(workdir, "scripts", "check.sh"), AGENT_CHECK);
      sh("-C", workdir, "add", "scripts/check.sh");
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
    ...(over.wired === false ? {} : {
      checkStep: createCheckStep({ capture: (command, args, env, cwd, timeoutMs, tail, signal, feed) => runInstall(spawn, command, args, env, cwd, timeoutMs, tail, signal, feed), now: () => new Date(), vcsState: createVcsState(captureLarge, {}) }),
      baseFile: createBaseFile(captureLarge, {}),
      checkLaunch: (target: SandboxHandle, argv: readonly string[]): CheckLaunch => (launchedIn.push(target.sandboxName), { tool: argv[0]!, args: argv.slice(1), env: SETUP_ENV() }),
      checkHome: home,
    }),
  };
  return {
    gitB, agentSandboxes, launchedIn, client, handle: createJobHandler(deps),
    async claim(check: Check | null = CHECK): Promise<Claimed> {
      cloud.enqueue(signRaw(jobFor({ mode: "verified", ...(check === null ? {} : { check }) })) as never);
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
