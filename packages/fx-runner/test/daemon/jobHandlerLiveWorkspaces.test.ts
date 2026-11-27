import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type Claimed } from "../../src/daemon/client.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { recordSession } from "../../src/engines/claude/session.js";
import { generateRunnerKey } from "../../src/keys.js";
import { roleToolsDigest } from "../../src/job/roleTools.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import { createLiveWorkspaces } from "../../src/job/workspacePrune.js";
import type { SandboxPort } from "../../src/sandbox/port.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { jobFor, KEYRING, signRaw } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

/** D#587 FU-318: the job handler holds a run's workspace (and a resumed one) in the registry the prune reads, from before the run starts until it ends on every path. */
const RUN = "44444444-4444-4444-8444-444444444444";
const PARENT = "33333333-3333-4333-8333-333333333333";
const continues = { parent_run_id: PARENT, session_id: "s1", branch: `fx/${PARENT}-g1` };

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fx318-handler-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

const clock: Clock = { now: () => new Date(), sleep: (ms, signal) => new Promise<void>((resolve) => { if (signal.aborted) return resolve(); const t = setTimeout(resolve, Math.min(ms, 1)); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); }) };

function rig(live: ReturnType<typeof createLiveWorkspaces>, kept?: string, endsWith: "done" | "throws" = "done") {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const client = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  /** The names held at the moment the agent was started, and which start was used. */
  const heldAtStart: string[][] = [];
  const how: string[] = [];
  const event = (runId: string): NormalizedEvent => ({ runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } });
  const port: SandboxPort = {
    async createSandbox(opts) { return { runId: "", sandboxName: opts.sandboxName }; },
    startDetached: (handle, opts) => {
      how.push("fresh");
      heldAtStart.push(live.names());
      if (endsWith === "throws") throw new Error("agent start failed");
      return { handle, hookFired: Promise.resolve(event(opts.runId)) };
    },
    resume: (handle, _sessionId, _prompt, opts) => {
      how.push("resume");
      heldAtStart.push(live.names());
      return { handle, hookFired: Promise.resolve(event(opts.runId)) };
    },
    async extendTimeout() {}, async stop() {}, async deleteSandbox() {}, async measure() { return []; }, async readCounters() { return undefined; }, async writeFiles() {}, async runCommand(): Promise<never> { throw new Error("not used"); }, async sandboxExists() { return true; },
  };
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => (kept === undefined ? { kind: "fresh", branch: null } : { kind: "resume", sessionId: "s1", workspace: kept }), defaultModel: "sonnet" };
  const git = fakeGitPath({ resume: async () => ({ base: "c".repeat(40) }), prepare: async () => ({ base: "c".repeat(40) }) });
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()), git, events: createEventRelay(),
    recordSession: (id, workspace) => recordSession(path.join(root, "sessions.json"), id, workspace), heartbeatMs: 1e9, flushMs: 1e9, runJobFn: runJob,
    liveWorkspaces: live,
  };
  const handle = createJobHandler(deps);
  return {
    heldAtStart, how,
    async go(over: Parameters<typeof jobFor>[0] = {}) {
      const role = over?.role ?? "executor";
      cloud.enqueue(signRaw(jobFor({ run_id: RUN, ...over, role_tools_sha256: roleToolsDigest(role) })) as never);
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return handle(claimed as Claimed);
    },
  };
}

describe("the run's workspace is held while the run is in hand", () => {
  it("a fresh run holds its own directory from before the agent starts, and releases it when the run ends", async () => {
    const live = createLiveWorkspaces();
    const r = rig(live);
    expect((await r.go()).status).toBe("completed");
    expect(r.heldAtStart).toEqual([[RUN]]);
    expect(live.names()).toEqual([]);
  });

  it("a run that fails still releases", async () => {
    const live = createLiveWorkspaces();
    const r = rig(live, undefined, "throws");
    await r.go().catch(() => undefined);
    expect(r.heldAtStart).toEqual([[RUN]]);
    expect(live.names()).toEqual([]);
  });

  it("a fix round holds the resumed directory as well as its own, and releases both", async () => {
    const kept = path.join(root, "work", "0f3c9a1e-5b7d-4c2a-9e18-6a4b2d7c1f01");
    mkdirSync(kept, { recursive: true });
    const live = createLiveWorkspaces();
    const r = rig(live, kept);
    expect((await r.go({ continues })).status).toBe("completed");
    expect(r.how).toEqual(["resume"]);
    expect(r.heldAtStart[0]).toEqual(["0f3c9a1e-5b7d-4c2a-9e18-6a4b2d7c1f01", RUN].sort());
    expect(live.names()).toEqual([]);
  });

  it("a fix round whose old directory the prune is removing starts fresh and never enters it", async () => {
    const name = "0f3c9a1e-5b7d-4c2a-9e18-6a4b2d7c1f01";
    const kept = path.join(root, "work", name);
    mkdirSync(kept, { recursive: true });
    const live = createLiveWorkspaces();
    const release = live.claimForPrune(name);
    expect(release).toBeTypeOf("function");
    const r = rig(live, kept);
    expect((await r.go({ continues })).status).toBe("completed");
    expect(r.how).toEqual(["fresh"]);
    expect(r.heldAtStart[0]).toEqual([RUN]);
    release?.();
  });
});
