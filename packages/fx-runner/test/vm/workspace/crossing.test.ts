import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import type { StartDetachedOptions } from "../../../src/sandbox/port.js";
import { createMicrovmSandbox } from "../../../src/vm/sandboxd/microvmSandbox.js";
import type { SdkSandbox } from "../../../src/vm/sandboxd/sdkSlice.js";
import { createWorkspaceCrossing, type WorkspaceSource } from "../../../src/vm/workspace/crossing.js";
import { GUEST_WORKSPACE } from "../../../src/vm/workspace/guestWorkspace.js";
import { buildWorkspaceArchive } from "../../../src/daemon/vmArchive.js";
import { createGit } from "../../../src/daemon/git.js";
import { fixtureRepo, git, GIT_ENV, localGuest, scratchDir } from "./helpers.js";

/** The daemon's guarded git, bound to real processes with the test environment. */
function hostDeps() {
  const capture = async (command: string, args: readonly string[], env: Record<string, string>) => {
    try {
      return { code: 0, stdout: execFileSync(command, [...args], { env: { ...GIT_ENV(), ...env }, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }), timedOut: false };
    } catch (error) {
      return { code: (error as { status?: number }).status ?? 1, stdout: "", timedOut: false };
    }
  };
  const g = createGit({ capture });
  return { git: g, gitLarge: g, scratchDir: scratchDir("fxw-scratch-") };
}

const EVENT = (runId: string): NormalizedEvent => ({ runId, role: "executor", seq: 1, type: "result", ts: "2026-10-08T12:00:00.000Z", sessionId: "s1", agentOutput: { verdict: "done" } });

/** A microVM port whose guest is a real directory, with a scripted runtime that records what it was given and what the guest held when it started. */
function rig() {
  const local = localGuest();
  const seen: { made: StartDetachedOptions[]; started: Array<Record<string, unknown>>; guestAtStart: Array<{ head: string; tree: string }>; guestPath: string[] } = { made: [], started: [], guestAtStart: [], guestPath: [] };
  const sandboxes = new Map<string, SdkSandbox>();
  const fakeSandbox = (name: string): SdkSandbox =>
    ({ ...local.guest, name, status: "running", timeout: 120_000, persistent: false, currentSession: () => ({ sessionId: `${name}-1` }), updateNetworkPolicy: async () => ({}), extendTimeout: async () => undefined, stop: async () => ({}), delete: async () => undefined, listSessions: async () => ({ sessions: [], pagination: { next: null } }) }) as unknown as SdkSandbox;
  const sdk = {
    create: async (p: { name: string }) => (sandboxes.set(p.name, fakeSandbox(p.name)), sandboxes.get(p.name) as SdkSandbox),
    get: async (p: { name: string }) => sandboxes.get(p.name) as SdkSandbox,
    setTimeoutMs: async () => undefined,
    armTimeoutAt: async () => undefined,
  };
  const crossing = createWorkspaceCrossing(
    (_guest, job) => {
      seen.made.push(job);
      const runtime: AgentRuntime = {
        async start(o: { runId: string; workdir: string; onEvent: (e: NormalizedEvent) => unknown }) {
          seen.started.push(o as unknown as Record<string, unknown>);
          seen.guestPath.push(o.workdir);
          seen.guestAtStart.push({ head: git(local.paths.workspace, "rev-parse", "HEAD"), tree: git(local.paths.workspace, "rev-parse", "HEAD^{tree}") });
          await o.onEvent(EVENT(o.runId));
          return { handle: { runId: o.runId, done: Promise.resolve({ status: "ok" }) } as never };
        },
        async stop() {},
      } as unknown as AgentRuntime;
      return runtime;
    },
    { paths: local.paths },
  );
  const port = createMicrovmSandbox({ sdk: sdk as never, makeRuntime: crossing.makeRuntime });
  return { local, seen, crossing, port };
}
const opts = (workdir: string, over: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({ runId: "run-1", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir, capUsd: 0, networkPolicy: [], env: {}, onEvent: () => undefined, ...over });

describe("the workspace crossing in front of the microVM port", () => {
  it("the repository is in the guest, at the start commit, before the agent exists; the agent starts in the guest's directory", async () => {
    const fx = fixtureRepo();
    const { local, seen, crossing, port } = rig();
    const deps = hostDeps();
    const hostWorkspace = path.join(scratchDir("fxw-host-"), "ws");
    mkdirSync(hostWorkspace);
    const source: WorkspaceSource = { startCommit: async () => fx.commit, archive: (commit) => buildWorkspaceArchive(deps, fx.mirror, commit) };
    crossing.bind("run-1", source);
    const handle = await port.createSandbox({ sandboxName: "rn-run-1", retention: { persistent: false }, timeoutMs: 60_000 });
    const events: NormalizedEvent[] = [];
    const { hookFired } = port.startDetached(handle, opts(hostWorkspace, { onEvent: (e) => void events.push(e) }));
    expect(await hookFired).toMatchObject({ type: "result" });
    expect(seen.guestAtStart).toEqual([{ head: fx.commit, tree: fx.tree }]);
    expect(seen.guestPath).toEqual([GUEST_WORKSPACE].map(() => local.paths.workspace));
    expect(events.map((e) => e.type)).toEqual(["result"]);
  });

  it("no host path reaches the runtime builder, the agent's start options, or any command or file sent to the guest", async () => {
    const fx = fixtureRepo();
    const { local, seen, crossing, port } = rig();
    const deps = hostDeps();
    const hostWorkspace = path.join(scratchDir("fxw-host-"), "ws");
    mkdirSync(hostWorkspace);
    crossing.bind("run-1", { startCommit: async () => fx.commit, archive: (commit) => buildWorkspaceArchive(deps, fx.mirror, commit) });
    const handle = await port.createSandbox({ sandboxName: "rn-run-1", retention: { persistent: false }, timeoutMs: 60_000 });
    await port.startDetached(handle, opts(hostWorkspace)).hookFired;
    const hostPaths = [hostWorkspace, path.dirname(hostWorkspace), fx.mirror, fx.repo, deps.scratchDir];
    const wire = JSON.stringify({ made: seen.made, started: seen.started, commands: local.sent.commands, files: local.sent.files.filter((f) => !f.path.endsWith("archive.b64")) });
    for (const hostPath of hostPaths) expect(wire.includes(hostPath), hostPath).toBe(false);
    expect(seen.made[0]?.workdir).toBe(local.paths.workspace);
  });

  it("a start with no source bound for its run is refused before anything is sent, and so is a resume (the copy is not reopened in this part)", async () => {
    const { local, crossing, port } = rig();
    const handle = await port.createSandbox({ sandboxName: "rn-run-1", retention: { persistent: false }, timeoutMs: 60_000 });
    await expect(port.startDetached(handle, opts("/host/ws")).hookFired).rejects.toMatchObject({ code: "workspace_missing" });
    expect(local.sent.files).toEqual([]);
    crossing.bind("run-1", { startCommit: async () => "a".repeat(40), archive: async () => Promise.reject(new Error("must not be built")) });
    await expect(port.resume(handle, "s1", "go on", opts("/host/ws")).hookFired).rejects.toMatchObject({ code: "workspace_missing" });
    crossing.unbind("run-1");
    await expect(port.startDetached(handle, opts("/host/ws")).hookFired).rejects.toMatchObject({ code: "workspace_missing" });
    expect(local.sent.files).toEqual([]);
  });

  it("a guest that cannot take the archive ends the start with the closed unpack code; the agent never starts", async () => {
    const fx = fixtureRepo();
    const { seen, crossing, port } = rig();
    const deps = hostDeps();
    crossing.bind("run-1", { startCommit: async () => fx.commit, archive: async (commit) => ({ ...(await buildWorkspaceArchive(deps, fx.mirror, commit)), tree: "e".repeat(40) }) });
    const handle = await port.createSandbox({ sandboxName: "rn-run-1", retention: { persistent: false }, timeoutMs: 60_000 });
    await expect(port.startDetached(handle, opts("/host/ws")).hookFired).rejects.toMatchObject({ code: "unpack_failed" });
    expect(seen.started).toEqual([]);
  });

  it("`quiesce` and `guestOf` give the runner's own steps the running guest, and `guestOf` refuses a name the port does not hold", async () => {
    const { crossing, port } = rig();
    void crossing;
    const handle = await port.createSandbox({ sandboxName: "rn-run-1", retention: { persistent: false }, timeoutMs: 60_000 });
    expect((await port.guestOf(handle)).name).toBe("rn-run-1");
    await expect(port.quiesce(handle)).resolves.toBeUndefined();
    await expect(port.quiesce({ runId: "", sandboxName: "other" })).resolves.toBeUndefined();
  });
});
