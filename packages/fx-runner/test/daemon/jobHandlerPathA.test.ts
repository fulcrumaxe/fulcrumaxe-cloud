import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { createRunnerClient, type RunnerClient } from "../../src/daemon/client.js";
import { GitPathError } from "../../src/daemon/git.js";
import { createJobHandler, type JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { createEventRelay, type Clock } from "../../src/daemon/lease.js";
import { createFileLedger } from "../../src/daemon/ledger.js";
import { runJob, type RunJobDeps } from "../../src/job/runJob.js";
import { createWorkspaceStore } from "../../src/job/workspace.js";
import { generateRunnerKey } from "../../src/keys.js";
import type { SandboxHandle, SandboxPort } from "../../src/sandbox/port.js";
import { fakeGitPath } from "../helpers/fakeGitPath.js";
import { ledgerOptions } from "../helpers/ledgerOptions.js";
import { KEYRING, signedJob } from "../helpers/signedJob.js";
import { startStrictRunnerCloud, type StrictRunnerCloud } from "../helpers/strictRunnerCloud.js";

const clock: Clock = {
  now: () => new Date(),
  sleep: (_ms, signal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : setTimeout(resolve, 1))),
};

let cloud: StrictRunnerCloud;
let root: string;
beforeEach(async () => {
  cloud = await startStrictRunnerCloud();
  root = mkdtempSync(path.join(tmpdir(), "fxr-handler-a-"));
});
afterEach(async () => {
  await cloud.close();
  rmSync(root, { recursive: true, force: true });
});

function rig(over: Partial<JobHandlerDeps> = {}) {
  const key = generateRunnerKey();
  cloud.trust(key.publicJwk);
  const real = createRunnerClient({ origin: cloud.origin, key, now: () => new Date(), fetchFn: fetch });
  const gitTicket = vi.fn(real.gitTicket);
  const client: RunnerClient = { ...real, gitTicket };
  let sandboxes = 0;
  const handle: SandboxHandle = { runId: "", sandboxName: "rn" };
  const result = (runId: string): NormalizedEvent => ({ runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s", agentOutput: { verdict: "done" } });
  const port: SandboxPort = {
    async createSandbox(opts) {
      sandboxes++;
      return { ...handle, sandboxName: opts.sandboxName };
    },
    startDetached: (_h, opts) => ({ handle, hookFired: Promise.resolve(result(opts.runId)) }),
    resume: (_h, _s, _p, opts) => ({ handle, hookFired: Promise.resolve(result(opts.runId)) }),
    async extendTimeout() {},
    async stop() {},
    async deleteSandbox() {},
    async measure() {
      return [];
    },
    async readCounters() {
      return undefined;
    },
    async sandboxExists() {
      return true;
    },
  };
  let runs = 0;
  const run: Omit<RunJobDeps, "sandbox" | "ledger"> = { workspaces: createWorkspaceStore(path.join(root, "work")), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet" };
  const deps: JobHandlerDeps = {
    client, keyring: KEYRING, clock, run, sandbox: port, ledger: createFileLedger(path.join(root, "jobs.json"), ledgerOptions()), git: fakeGitPath(), events: createEventRelay(),
    recordSession: async () => {}, heartbeatMs: 1e9, flushMs: 1e9, runJobFn: (job, d) => (runs++, runJob(job, d)), ...over,
  };
  return {
    handle: createJobHandler(deps), client, gitTicket, runs: () => runs, sandboxCalls: () => sandboxes,
    async claim(mode: "local" | "verified") {
      cloud.enqueue(signedJob({ mode }));
      const claimed = await client.claim();
      if (claimed.kind !== "claimed") throw new Error("expected a claim");
      return claimed;
    },
  };
}
const sent = (): string[] => cloud.seen.map((s) => s.path.replace(/[0-9a-f-]{36}/, ":id"));
const ended = (runId: string) => cloud.runs.get(runId)?.endedBy;
const throwing = (code: ConstructorParameters<typeof GitPathError>[0], sizeMb?: number) => async (): Promise<never> => {
  throw new GitPathError(code, sizeMb);
};

describe("the signed job's mode picks the git path", () => {
  it("a local job takes path B and never asks for a ticket", async () => {
    const b = fakeGitPath();
    const a = fakeGitPath();
    const r = rig({ git: b, gitA: a });
    const claimed = await r.claim("local");
    expect((await r.handle(claimed)).status).toBe("completed");
    expect(b.calls.map((c) => c.split(" ")[0])).toEqual(["check", "prepare", "publish"]);
    expect(a.calls).toEqual([]);
    expect(r.gitTicket).not.toHaveBeenCalled();
  });

  it("a verified job takes path A and never path B", async () => {
    const b = fakeGitPath();
    const a = fakeGitPath();
    const r = rig({ git: b, gitA: a });
    const claimed = await r.claim("verified");
    expect((await r.handle(claimed)).status).toBe("completed");
    expect(a.calls.map((c) => c.split(" ")[0])).toEqual(["check", "prepare", "publish"]);
    expect(b.calls).toEqual([]);
  });

  it("a verified job on a build with no pinned proxy ends git_proxy_unpinned before any git call, and runs nothing", async () => {
    const b = fakeGitPath();
    const r = rig({ git: b });
    const claimed = await r.claim("verified");
    expect(await r.handle(claimed)).toEqual({ status: "failed", reason: "git_proxy_unpinned" });
    expect(b.calls).toEqual([]);
    expect(r.runs()).toBe(0);
    expect(ended(claimed.runId)).toMatchObject({ type: "run_ended", reason: "runner_setup", detail: "git_proxy_unpinned" });
    expect(sent().some((p) => p.endsWith("/done"))).toBe(false);
  });
});

describe("an unknown model id on a verified job", () => {
  it("ends model_unsupported before any path A call: no ticket, no proxy session, no sandbox, no run", async () => {
    const a = fakeGitPath();
    const b = fakeGitPath();
    const r = rig({ git: b, gitA: a });
    cloud.enqueue(signedJob({ mode: "verified", model_hint: "opus-9" }));
    const claimed = await r.client.claim();
    if (claimed.kind !== "claimed") throw new Error("expected a claim");
    expect(await r.handle(claimed)).toEqual({ status: "failed", reason: "model_unsupported" });
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
    expect(r.gitTicket).not.toHaveBeenCalled();
    expect(r.runs()).toBe(0);
    expect(r.sandboxCalls()).toBe(0);
    expect(ended(claimed.runId)).toMatchObject({ type: "run_ended", reason: "runner_setup", detail: "model_unsupported" });
  });
});

describe("path A's ends are reported as closed codes, or not at all when the cloud has stopped the run", () => {
  it("a check that refuses (no lasting mirror) ends the run before it starts", async () => {
    const r = rig({ gitA: fakeGitPath({ check: () => { throw new GitPathError("path_a_no_mirror"); } }) });
    const claimed = await r.claim("verified");
    expect(await r.handle(claimed)).toEqual({ status: "failed", reason: "path_a_no_mirror" });
    expect(r.runs()).toBe(0);
    expect(ended(claimed.runId)).toMatchObject({ reason: "runner_setup", detail: "path_a_no_mirror" });
  });

  it("push_too_large goes with the size in whole MB, and no done is sent", async () => {
    const r = rig({ gitA: fakeGitPath({ publish: throwing("push_too_large", 7) }) });
    const claimed = await r.claim("verified");
    expect(await r.handle(claimed)).toEqual({ status: "failed", reason: "push_too_large" });
    expect(ended(claimed.runId)).toMatchObject({ reason: "runner_setup", detail: "push_too_large", size_mb: 7 });
    expect(sent().some((p) => p.endsWith("/done"))).toBe(false);
  });

  for (const code of ["push_incomplete", "clone_limited", "git_ticket_refused"] as const) {
    it(`${code} is a setup detail, with no size and no done`, async () => {
      const r = rig({ gitA: fakeGitPath({ publish: throwing(code) }) });
      const claimed = await r.claim("verified");
      expect(await r.handle(claimed)).toEqual({ status: "failed", reason: code });
      const end = ended(claimed.runId);
      expect(end).toMatchObject({ reason: "runner_setup", detail: code });
      expect(end?.size_mb).toBeUndefined();
      expect(sent().some((p) => p.endsWith("/done"))).toBe(false);
    });
  }

  for (const code of ["git_stopped", "git_revoked"] as const) {
    for (const step of ["prepare", "publish"] as const) {
      it(`${code} at ${step} stops the run quietly: no run_ended, no done`, async () => {
        const r = rig({ gitA: fakeGitPath({ [step]: throwing(code) }) });
        const claimed = await r.claim("verified");
        expect((await r.handle(claimed)).status).toBe("stopped");
        expect(ended(claimed.runId)).toBeUndefined();
        expect(sent().some((p) => p.endsWith("/done"))).toBe(false);
      });
    }
  }
});
