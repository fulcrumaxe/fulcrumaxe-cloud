import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { buildWorkspaceArchive } from "../../../src/daemon/vmArchive.js";
import { applyBundle } from "../../../src/daemon/vmBundle.js";
import { pinWorkspace } from "../../../src/daemon/workspacePin.js";
import { createMemoryLedger, runJob } from "../../../src/job/runJob.js";
import { createWorkspaceStore } from "../../../src/job/workspace.js";
import type { SandboxPort, StartDetachedOptions } from "../../../src/sandbox/port.js";
import { createMicrovmSandbox } from "../../../src/vm/sandboxd/microvmSandbox.js";
import type { SdkSandbox } from "../../../src/vm/sandboxd/sdkSlice.js";
import { createWorkspaceCrossing } from "../../../src/vm/workspace/crossing.js";
import { jobFor } from "../../helpers/signedJob.js";
import { fixtureRepo, git, GIT_ENV, hostDeps, localGuest, scratchDir } from "./helpers.js";

const at = "2026-10-08T12:00:00.000Z";
/** The scripted model stand-in: the same edits and the same commit (fixed identity and time) wherever it runs, and the same events in the same order. */
async function scriptedAgent(dir: string, runId: string, onEvent: (e: NormalizedEvent) => void | Promise<void>): Promise<NormalizedEvent> {
  await onEvent({ runId, role: "executor", seq: 0, type: "assistant", ts: at, text: "working" } as unknown as NormalizedEvent);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "feature.ts"), "export const feature = 1;\n");
  writeFileSync(path.join(dir, "README.md"), "hello\nmore\n");
  const env = { GIT_AUTHOR_DATE: "2026-10-08T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-08T12:00:00Z" };
  git(dir, "add", "-A");
  execGitWithEnv(dir, env);
  await onEvent({ runId, role: "executor", seq: 1, type: "tool_use", ts: at, tool: "Bash" } as unknown as NormalizedEvent);
  const result = { runId, role: "executor", seq: 2, type: "result", ts: at, sessionId: "s1", agentOutput: { verdict: "done" } } as unknown as NormalizedEvent;
  await onEvent(result);
  return result;
}
function execGitWithEnv(dir: string, env: Record<string, string>): void {
  execFileSync("git", ["commit", "-qm", "implement the feature"], { cwd: dir, env: { ...GIT_ENV(), ...env } });
}

const noopPort = (over: Partial<SandboxPort>): SandboxPort => ({
  async createSandbox(o) {
    return { runId: "", sandboxName: o.sandboxName };
  },
  startDetached: () => {
    throw new Error("not used");
  },
  resume: () => {
    throw new Error("not used");
  },
  async extendTimeout() {},
  async stop() {},
  async deleteSandbox() {},
  async measure() {
    return [];
  },
  async readCounters() {
    return undefined;
  },
  async writeFiles() {},
  async runCommand(): Promise<never> {
    throw new Error("not used");
  },
  async sandboxExists() {
    return true;
  },
  ...over,
});

describe("the same job ends with the same recorded result in a microVM as on the OS sandbox", () => {
  const job = jobFor();
  async function run(kind: "os" | "vm") {
    const fx = fixtureRepo();
    const root = mkdtempSync(path.join(scratchDir("fxw-eq-"), "r-"));
    const store = createWorkspaceStore(path.join(root, "work"));
    const filled = {
      ...store,
      async create(runId: string) {
        const dir = await store.create(runId);
        git(root, "clone", "-q", "--shared", fx.mirror, dir);
        git(dir, "checkout", "-q", "-B", "fx/run", fx.commit);
        pinWorkspace(dir, path.join(fx.mirror, "objects"));
        return dir;
      },
    };
    const events: NormalizedEvent[] = [];
    const deps = hostDeps();
    let afterAgent: ((handle: { runId: string; sandboxName: string }, workspace: string) => Promise<void>) | undefined;
    let port: SandboxPort;
    if (kind === "os") {
      port = noopPort({ startDetached: (handle, opts: StartDetachedOptions) => ({ handle, hookFired: scriptedAgent(opts.workdir as string, opts.runId, opts.onEvent) }) });
    } else {
      const local = localGuest();
      const sandboxes = new Map<string, SdkSandbox>();
      const fake = (name: string): SdkSandbox => ({ ...local.guest, name, status: "running", timeout: 1e8, persistent: true, currentSession: () => ({ sessionId: `${name}-1` }), updateNetworkPolicy: async () => ({}), extendTimeout: async () => undefined, stop: async () => ({}), delete: async () => undefined, listSessions: async () => ({ sessions: [], pagination: { next: null } }) }) as unknown as SdkSandbox;
      const sdk = { create: async (p: { name: string }) => (sandboxes.set(p.name, fake(p.name)), sandboxes.get(p.name) as SdkSandbox), get: async (p: { name: string }) => sandboxes.get(p.name) as SdkSandbox, setTimeoutMs: async () => undefined, armTimeoutAt: async () => undefined };
      const crossing = createWorkspaceCrossing(
        () => ({
          async start(start: { runId: string; workdir: string; onEvent: (e: NormalizedEvent) => void | Promise<void> }) {
            const done = scriptedAgent(start.workdir, start.runId, start.onEvent);
            return { handle: { runId: start.runId, done: done.then(() => ({ status: "ok" })) } as never };
          },
          async stop() {},
        }) as unknown as AgentRuntime,
        { paths: local.paths },
      );
      const vm = createMicrovmSandbox({ sdk: sdk as never, makeRuntime: crossing.makeRuntime });
      port = vm;
      crossing.bind(job.run_id, { startCommit: async () => fx.commit, archive: (c) => buildWorkspaceArchive(deps, fx.mirror, c) });
      afterAgent = async (handle, workspace) => {
        await vm.quiesce(handle);
        const collected = await crossing.collect(job.run_id, await vm.guestOf(handle));
        if (collected !== null) await applyBundle(deps, { bundle: collected.bundle, base: collected.base, mirrorDir: fx.mirror, workspace });
      };
    }
    const result = await runJob(job, { sandbox: port, workspaces: filled, ledger: createMemoryLedger(), credentials: { mode: "subscription" }, planSession: () => ({ kind: "fresh", branch: null }), defaultModel: "sonnet", onEvent: (e) => void events.push(e), ...(afterAgent === undefined ? {} : { afterAgent }) });
    if (result.status !== "done") throw new Error(`run ended ${JSON.stringify(result)}`);
    const ws = result.workspace;
    return { events, tree: git(ws, "rev-parse", "HEAD^{tree}"), head: git(ws, "rev-parse", "HEAD"), log: git(ws, "log", "--format=%an|%s", `${fx.commit}..HEAD`), status: git(ws, "status", "--porcelain"), files: git(ws, "ls-tree", "-r", "--name-only", "HEAD"), result };
  }

  it("same resulting tree hash, same commits, same events in the same order, a clean workspace", async () => {
    const os = await run("os");
    const vm = await run("vm");
    expect(vm.tree).toBe(os.tree);
    expect(vm.head).toBe(os.head);
    expect(vm.log).toBe(os.log);
    expect(vm.files).toBe(os.files);
    expect(vm.status).toBe("");
    expect(os.events.map((e) => e.type)).toEqual(["assistant", "tool_use", "result"]);
    expect(vm.events).toEqual(os.events);
    expect(vm.result).toMatchObject({ status: "done", sessionId: "s1" });
  });
});
