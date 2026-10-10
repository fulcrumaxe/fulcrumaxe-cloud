import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { createNixShell, type NixDetail, type NixSkip, type NixSource } from "../../src/daemon/nixShell.js";
import { runCapture } from "../../src/engines/claude/capture.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import type { SandboxPort, StartDetachedOptions } from "../../src/sandbox/port.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { generateRunnerKey } from "../../src/keys.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { NIX_FLAKE_CHANGED_NOTE } from "../../src/job/prompt.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/**
 * D#6 R7c in the job handler: which jobs get the dev shell step, and what reaches the sandbox. The step is the real one, run with a fake `nix` script
 * through the real process path, so "nix was not started" is read off a log the script writes, not off a flag a stub sets.
 */
const BASE = "c".repeat(40);
const MERGE_BASE = "d".repeat(40);
const STORE = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOCK = JSON.stringify({ version: 7, root: "root", nodes: { root: { inputs: {} } } });
const ENTRIES = [{ kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install" }];
const RUN_BRANCH = "fx/33333333-3333-4333-8333-333333333333-g1";

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-nixhandler-"));
  const nix = path.join(root, "nix");
  writeFileSync(
    nix,
    `#!/bin/sh
echo "$@" >> "${root}/calls.log"
case "$*" in
  *"config show trusted-users"*) echo root; exit 0;;
  *print-dev-env*) echo '{"variables":{"PATH":{"type":"exported","value":"${STORE}-node/bin:/usr/bin"},"CC":{"type":"exported","value":"gcc"},"shellHook":{"type":"exported","value":"x"}}}'; exit 0;;
esac
exit 9
`,
  );
  chmodSync(nix, 0o755);
  // a stand-in for bubblewrap: runs what follows `--`
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
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };
const capture = (command: string, args: readonly string[], env: Record<string, string>, timeoutMs: number) => runCapture(spawn, command, args, env, timeoutMs, 1024 * 1024, 2048);
const nixCalls = (): string[] => (existsSync(path.join(root, "calls.log")) ? readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n") : []);

function rig(over: { source?: NixSource | (() => never); skips?: NixSkip[]; details?: NixDetail[]; sources?: string[] } = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const starts: StartDetachedOptions[] = [];
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      starts.push(opts);
      const event: NormalizedEvent = { runId: opts.runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } };
      return { handle, hookFired: Promise.resolve(event) };
    },
    resume: () => { throw new Error("not used"); },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const git = fakeGitPath({ prepare: async () => ({ base: BASE }) });
  const sources: string[] = over.sources ?? [];
  git.nixSource = async (_job, sha) => {
    sources.push(sha);
    if (typeof over.source === "function") over.source();
    return (over.source as NixSource | undefined) ?? { kind: "flake", mirrorDir: "/cache/mirrors/m.git", lock: LOCK };
  };
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    nix: createNixShell({ nixBin: path.join(root, "nix"), bwrapBin: path.join(root, "bwrap"), viewFs: { exists: () => true, isDir: () => true, isFile: () => false, list: () => [] }, capture, dataDir: path.join(root, "nix-data"), storeExists: () => true, identity: async () => ({ user: "runner", groups: ["users"] }) }),
    onNixSkip: (skip) => over.skips?.push(skip),
    onNixDetail: (detail) => over.details?.push(detail),
  };
  const handle = createJobHandler(deps);
  return {
    starts, sources, handle,
    async claim(job: ReturnType<typeof jobFor>): Promise<Claimed> {
      cloud.enqueue(signRaw(job) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}

describe("D#6 R7c: the dev shell step in the job handler", () => {
  it("control: a job with signed allowances, on a default-branch base, starts with the filtered shell and a granted store", async () => {
    const r = rig();
    const result = await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })));
    expect(result.status).toBe("completed");
    expect(r.sources).toEqual([BASE]);
    expect(r.starts).toHaveLength(1);
    expect(r.starts[0]!.allowances?.nixEnv).toEqual({ PATH: `${STORE}-node/bin`, CC: "gcc" });
    expect(nixCalls().filter((line) => line.includes("print-dev-env"))).toHaveLength(1);
  });

  it("a job with no signed allowances never starts nix or asks the git path about the flake", async () => {
    const r = rig();
    expect((await r.handle(await r.claim(jobFor()))).status).toBe("completed");
    expect(nixCalls()).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.starts[0]!.allowances).toBeUndefined();
  });

  it("a fix-round-shaped job is asked about its shell like any other: a base off the default branch is built from its merge-base", async () => {
    const details: NixDetail[] = [];
    const r = rig({ details, source: { kind: "flake", mirrorDir: "/cache/mirrors/m.git", lock: LOCK, fromDefault: { rev: MERGE_BASE, flakeChanged: false } } });
    const job = jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never, continues: { parent_run_id: "33333333-3333-4333-8333-333333333333", session_id: "s1", branch: RUN_BRANCH } });
    expect((await r.handle(await r.claim(job))).status).toBe("completed");
    expect(r.sources).toEqual([BASE]);
    expect(details).toEqual(["nix_from_default_branch"]);
    expect(r.starts[0]!.allowances?.nixEnv).toBeDefined();
  });

  it("a head off the default branch: nix is told the merge-base and never the head, the detail is named, onNixSkip stays silent, the prompt has no flake note", async () => {
    const details: NixDetail[] = [];
    const skips: NixSkip[] = [];
    const r = rig({ details, skips, source: { kind: "flake", mirrorDir: "/cache/mirrors/m.git", lock: LOCK, fromDefault: { rev: MERGE_BASE, flakeChanged: false } } });
    expect((await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })))).status).toBe("completed");
    const argv = nixCalls().filter((line) => line.includes("print-dev-env"));
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain(`?rev=${MERGE_BASE}`);
    expect(argv[0]).not.toContain(BASE);
    expect(details).toEqual(["nix_from_default_branch"]);
    expect(skips).toEqual([]);
    expect(r.starts[0]!.allowances?.nixEnv).toEqual({ PATH: `${STORE}-node/bin`, CC: "gcc" });
    expect(r.starts[0]!.prompt).not.toContain(NIX_FLAKE_CHANGED_NOTE);
  });

  it("a head that changes the flake adds nix_flake_changed and the one fixed prompt line, ahead of the untrusted block", async () => {
    const details: NixDetail[] = [];
    const r = rig({ details, source: { kind: "flake", mirrorDir: "/cache/mirrors/m.git", lock: LOCK, fromDefault: { rev: MERGE_BASE, flakeChanged: true } } });
    expect((await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })))).status).toBe("completed");
    expect(details).toEqual(["nix_from_default_branch", "nix_flake_changed"]);
    expect(r.starts[0]!.prompt.split(NIX_FLAKE_CHANGED_NOTE)).toHaveLength(2);
    expect(r.starts[0]!.prompt.indexOf(NIX_FLAKE_CHANGED_NOTE)).toBeLessThan(r.starts[0]!.prompt.indexOf("<untrusted>"));
  });

  it("a shell that is skipped adds neither detail nor prompt line, even for a changed flake", async () => {
    const details: NixDetail[] = [];
    const skips: NixSkip[] = [];
    const r = rig({ details, skips, source: { kind: "flake", mirrorDir: "/cache/mirrors/m.git", lock: null, fromDefault: { rev: MERGE_BASE, flakeChanged: true } } });
    expect((await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })))).status).toBe("completed");
    expect(skips).toEqual(["nix_flake_lock_missing"]);
    expect(details).toEqual([]);
    expect(r.starts[0]!.prompt).not.toContain(NIX_FLAKE_CHANGED_NOTE);
  });

  it("a job whose base is on the default branch gets neither detail nor note", async () => {
    const details: NixDetail[] = [];
    const r = rig({ details });
    expect((await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })))).status).toBe("completed");
    expect(details).toEqual([]);
    expect(r.starts[0]!.prompt).not.toContain(NIX_FLAKE_CHANGED_NOTE);
  });

  it("two review jobs with one merge-base make one nix build and one cache hit", async () => {
    const r = rig({ source: { kind: "flake", mirrorDir: "/cache/mirrors/m.git", lock: LOCK, fromDefault: { rev: MERGE_BASE, flakeChanged: false } } });
    for (let round = 0; round < 2; round++) {
      expect((await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })))).status).toBe("completed");
    }
    expect(nixCalls().filter((line) => line.includes("print-dev-env"))).toHaveLength(1);
    expect(r.starts).toHaveLength(2);
    expect(r.starts[1]!.allowances?.nixEnv).toEqual(r.starts[0]!.allowances?.nixEnv);
  });

  it("a base the git path says is not on the default branch gets no shell, and the job still runs with its allowances", async () => {
    const skips: NixSkip[] = [];
    const r = rig({ source: { kind: "not_default_branch" }, skips });
    expect((await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })))).status).toBe("completed");
    expect(nixCalls()).toEqual([]);
    expect(skips).toEqual(["nix_not_default_branch"]);
    expect(r.starts[0]!.allowances).toMatchObject({ entries: ENTRIES, commandTimeoutS: 600 });
    expect(r.starts[0]!.allowances?.nixEnv).toBeUndefined();
  });

  it("a git path that cannot answer fails closed: no shell, the job still runs", async () => {
    const skips: NixSkip[] = [];
    const r = rig({ source: () => { throw new Error("mirror gone"); }, skips });
    expect((await r.handle(await r.claim(jobFor({ sandbox_allowances: { entries: ENTRIES, command_timeout_s: 600 } as never })))).status).toBe("completed");
    expect(skips).toEqual(["nix_failed"]);
    expect(nixCalls()).toEqual([]);
  });
});

