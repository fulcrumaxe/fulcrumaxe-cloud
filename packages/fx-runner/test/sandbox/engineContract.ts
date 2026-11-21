import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "@fulcrumaxe/runner-protocol";
import { SandboxNotFoundError, type SandboxHandle, type SandboxPort, type StartDetachedOptions } from "../../src/sandbox/port.js";
import { scriptedRuntime } from "../sandboxPortContract.js";

/**
 * D#587 B-5a: the one engine contract suite for the runner's `SandboxPort`. It runs unchanged against the host engine (with a stub agent runtime) and the
 * microVM engine (on the daemon, with the real-contract fake of the B-2b tests, and with real VMs where Firecracker and the helper exist). The older
 * `sandboxPortContract` holds the cases every adapter shares, including the cloud's; this one adds what a machine's engine promises beyond them:
 * a taken name, the lifecycle in order, a resume after a stop and after a loss, a stop and a delete twice, usage, counters, each state, files and a
 * command byte for byte, and the timeout.
 *
 * A behaviour that differs between the engines is not hidden: it is named here, once, with the reason, and a case that depends on it asks the subject
 * whether it declared it. A subject that declares a difference the suite does not know, or one without a reason, fails the suite's own checks.
 */
export const ALLOWED_DIFFERENCES = {
  publishCalls: "The host engine has no publish sandbox, so writeFiles and runCommand refuse (`no_publish_sandbox`); the microVM engine runs both in the guest.",
  idleState: "The host engine reports a sandbox as running only while its agent runs, so a created and idle one is `stopped`; a created microVM is up, so it is `running`.",
  usageFigures: "The host engine has nothing to measure and answers an empty list; the microVM engine reports the memory, region and duration of each session it ran.",
  lossShape: "A sandbox the host engine deleted is refused at once (the call throws); one the daemon lost behind the port's back is found out by the boot, so the run's own promises reject.",
  jobEnv: "Each engine checks a job's environment against its own table: the host engine accepts exactly the clean environment, the microVM engine a closed list of names (no credential, no CA-file variable); both refuse anything else with `env_not_clean`.",
} as const;
export type Difference = keyof typeof ALLOWED_DIFFERENCES;

export interface EngineSubject {
  port: SandboxPort;
  /** The env this engine accepts on a start. */
  env(role: string): Record<string, string>;
  /** A directory the engine accepts as the job's working directory. */
  workdir: string;
  timeoutMsOf(handle: SandboxHandle): number | undefined;
  /** The engine's `interrupt`: SIGINT to the agent once it exists. */
  interrupt(handle: SandboxHandle): Promise<void>;
  /** Makes the sandbox vanish as it would behind the port's back (a delete from the management plane, a daemon restart). */
  lose(handle: SandboxHandle): Promise<void>;
  /** The microVM engine's guest, read back: what a `put` stored. */
  guestFile?(handle: SandboxHandle, path: string): { data: Buffer; mode: number } | undefined;
}

const sandboxOpts = (name: string) => ({ sandboxName: name, retention: { persistent: false }, timeoutMs: 60_000 });
const startOpts = (subject: EngineSubject, over: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({
  runId: "run-1",
  role: "executor",
  roleCard: "role card",
  prompt: "do the thing",
  model: "sonnet",
  workdir: subject.workdir,
  capUsd: 1,
  networkPolicy: [],
  env: subject.env("executor"),
  onEvent: () => undefined,
  ...over,
});

/** What a call that may refuse at once or in its promises did, as one value. */
async function outcomeOf(call: () => { hookFired: Promise<unknown>; launched?: Promise<void> | undefined }): Promise<{ where: "throws" | "rejects"; error: unknown; launchedRejects: boolean }> {
  let started: ReturnType<typeof call>;
  try {
    started = call();
  } catch (error) {
    return { where: "throws", error, launchedRejects: false };
  }
  const launchedRejects = started.launched === undefined ? false : await started.launched.then(() => false, () => true);
  const error = await started.hookFired.then(() => undefined, (e: unknown) => e);
  return { where: "rejects", error, launchedRejects };
}

export function describeEngineContract(name: string, factory: (runtime: AgentRuntime) => EngineSubject, differences: ReadonlySet<Difference>): void {
  const differs = (d: Difference): boolean => differences.has(d);

  describe(`engine contract: ${name}`, () => {
    it("create answers a handle by name; a taken name is refused as `sandbox_exists`, and the first sandbox is left as it was", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-create"));
      expect(handle.sandboxName).toBe("e-create");
      await expect(subject.port.createSandbox(sandboxOpts("e-create"))).rejects.toMatchObject({ code: "sandbox_exists" });
      expect(await subject.port.sandboxExists(handle)).toBe(true);
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject));
      expect((await hookFired)?.seq).toBe(1);
    });

    it("a detached start returns at once; every event reaches onEvent in order before hookFired settles with the last one", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-events"));
      const seen: number[] = [];
      const result = subject.port.startDetached(handle, startOpts(subject, { onEvent: (e) => void seen.push(e.seq) }));
      expect(result).not.toBeInstanceOf(Promise);
      expect((await result.hookFired)?.seq).toBe(1);
      expect(seen).toEqual([0, 1]);
    });

    it("a second start while the first runs is refused as `sandbox_busy`", async () => {
      const runtime = scriptedRuntime({ hold: true });
      const subject = factory(runtime);
      const handle = await subject.port.createSandbox(sandboxOpts("e-busy"));
      const first = subject.port.startDetached(handle, startOpts(subject));
      expect(() => subject.port.startDetached(handle, startOpts(subject))).toThrowError(expect.objectContaining({ code: "sandbox_busy" }) as Error);
      runtime.release();
      await first.hookFired;
    });

    it("resume after a stop runs the same sandbox again and delivers its events in order", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-resume"));
      await (await subject.port.startDetached(handle, startOpts(subject)).hookFired);
      await subject.port.stop(handle);
      const seen: number[] = [];
      const resumed = subject.port.resume(handle, "sess-1", "carry on", startOpts(subject, { onEvent: (e) => void seen.push(e.seq) }));
      expect((await resumed.hookFired)?.seq).toBe(1);
      expect(seen).toEqual([0, 1]);
    });

    it("resume after the sandbox was lost is `SandboxNotFoundError` naming it", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-lost"));
      await subject.lose(handle);
      const outcome = await outcomeOf(() => subject.port.resume(handle, "sess-1", "carry on", startOpts(subject)));
      expect(outcome.where).toBe(differs("lossShape") ? "rejects" : "throws");
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).name).toBe(SandboxNotFoundError.name);
      expect((outcome.error as SandboxNotFoundError).sandboxName).toBe("e-lost");
      if (differs("lossShape")) expect(outcome.launchedRejects).toBe(true);
      expect(await subject.port.sandboxExists(handle)).toBe(false);
    });

    it("interrupt reaches the agent of a run that is going, once, and does nothing (and does not throw) for a sandbox that is gone", async () => {
      const interrupted: string[] = [];
      const runtime = Object.assign(scriptedRuntime({ hold: true }), { interrupt: (agent: { runId: string }) => void interrupted.push(agent.runId) });
      const subject = factory(runtime);
      const handle = await subject.port.createSandbox(sandboxOpts("e-interrupt"));
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject));
      await subject.interrupt(handle);
      expect(interrupted).toEqual(["run-1"]);
      runtime.release();
      await hookFired;
      await subject.port.deleteSandbox(handle);
      await expect(subject.interrupt(handle)).resolves.toBeUndefined();
      await expect(subject.interrupt({ runId: "", sandboxName: "e-interrupt-never-made", sessionId: "s" })).resolves.toBeUndefined();
      expect(interrupted).toEqual(["run-1"]);
    });

    it("stop and delete may be repeated: twice after a run, and on a sandbox that is gone", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-twice"));
      await subject.port.startDetached(handle, startOpts(subject)).hookFired;
      await subject.port.stop(handle);
      await expect(subject.port.stop(handle)).resolves.toBeUndefined();
      await subject.port.deleteSandbox(handle);
      await expect(subject.port.deleteSandbox(handle)).resolves.toBeUndefined();
      await expect(subject.port.stop(handle)).resolves.toBeUndefined();
      expect(await subject.port.sandboxExists(handle)).toBe(false);
    });

    it("stop ends a run that is going, and its hookFired then settles", async () => {
      const runtime = scriptedRuntime({ hold: true });
      const subject = factory(runtime);
      const handle = await subject.port.createSandbox(sandboxOpts("e-stoprun"));
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject));
      await subject.port.stop(handle);
      expect(runtime.stopped()).toBeGreaterThan(0);
      expect((await hookFired)?.seq).toBe(1);
    });

    it("measure with no sessions, or sessions the sandbox never ran, answers an empty list; the sessions it did run are reported only where the engine measures", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-measure"));
      let session: string | undefined;
      await subject.port.startDetached(handle, startOpts(subject, { onSession: (id) => void (session = id) })).hookFired;
      expect(session).toEqual(expect.any(String));
      expect(await subject.port.measure(handle, [])).toEqual([]);
      expect(await subject.port.measure(handle, ["not-a-session"])).toEqual([]);
      const usage = await subject.port.measure(handle, [session as string]);
      if (differs("usageFigures")) {
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({ sessionId: session, durationMs: expect.any(Number) });
        expect(usage[0]?.durationMs).toBeGreaterThanOrEqual(0);
      } else {
        expect(usage).toEqual([]);
      }
    });

    it("readCounters answers nothing: no engine here measures CPU time or egress bytes, and none makes a figure up", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-counters"));
      expect(await subject.port.readCounters(handle)).toBeUndefined();
    });

    it("sandboxState: gone for a name that is not there, running while a run goes, stopped after a stop, and an idle sandbox as the engine declares", async () => {
      const runtime = scriptedRuntime({ hold: true });
      const subject = factory(runtime);
      const handle = await subject.port.createSandbox(sandboxOpts("e-state"));
      expect(await subject.port.sandboxState?.(handle)).toBe(differs("idleState") ? "running" : "stopped");
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject));
      await new Promise((r) => setTimeout(r, 50));
      expect(await subject.port.sandboxState?.(handle)).toBe("running");
      runtime.release();
      await hookFired;
      await subject.port.stop(handle);
      expect(await subject.port.sandboxState?.(handle)).toBe("stopped");
      await subject.port.deleteSandbox(handle);
      expect(await subject.port.sandboxState?.(handle)).toBe("gone");
      expect(await subject.port.sandboxState?.({ runId: "", sandboxName: "e-never-made" })).toBe("gone");
    });

    it("writeFiles and runCommand: refused by an engine with no publish sandbox; byte for byte in a guest otherwise", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-files"));
      const command = { role: "plane_publish", cmd: "sh", args: ["-c", "printf 'o\\303\\251'; printf e >&2; exit 3"], env: subject.env("plane_publish"), networkPolicy: [], timeoutMs: 10_000 };
      if (!differs("publishCalls")) {
        await expect(subject.port.writeFiles(handle, [{ path: "/x/a", content: "a" }])).rejects.toMatchObject({ code: "no_publish_sandbox" });
        await expect(subject.port.runCommand(handle, command)).rejects.toMatchObject({ code: "no_publish_sandbox" });
        return;
      }
      const text = "héllo\nwörld ☃\n";
      await subject.port.writeFiles(handle, [{ path: "/fx/in/a.txt", content: text, mode: 0o600 }, { path: "/fx/in/b.txt", content: "" }]);
      const a = subject.guestFile?.(handle, "/fx/in/a.txt");
      expect(a?.data.equals(Buffer.from(text, "utf8"))).toBe(true);
      expect(a?.mode).toBe(0o600);
      expect(subject.guestFile?.(handle, "/fx/in/b.txt")).toMatchObject({ mode: 0o644 });
      expect(subject.guestFile?.(handle, "/fx/in/b.txt")?.data.length).toBe(0);
      let session: string | undefined;
      const ran = await subject.port.runCommand(handle, { ...command, onSession: (id) => void (session = id) });
      expect(ran).toMatchObject({ exitCode: 3, timedOut: false, stdout: "oé", stderr: "e", truncated: false });
      expect(ran.sessionId).toBe(session);
    });

    it("extendTimeout adds to the sandbox's limit, and does nothing for a sandbox that is gone", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-extend"));
      const before = subject.timeoutMsOf(handle);
      await subject.port.extendTimeout(handle, 5_000);
      expect(subject.timeoutMsOf(handle)).toBe((before ?? 0) + 5_000);
      await subject.port.deleteSandbox(handle);
      await expect(subject.port.extendTimeout(handle, 5_000)).resolves.toBeUndefined();
    });

    it("a job environment outside the engine's own table is refused as `env_not_clean` before anything starts, on a start and on a command alike", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("e-env"));
      const bad = startOpts(subject, { env: { ...subject.env("executor"), EXTRA_NOT_ALLOWED: "1" } });
      expect(() => subject.port.startDetached(handle, bad)).toThrowError(expect.objectContaining({ code: "env_not_clean" }) as Error);
      expect(() => subject.port.resume(handle, "sess-1", "carry on", bad)).toThrowError(expect.objectContaining({ code: "env_not_clean" }) as Error);
      const command = { role: "plane_publish", cmd: "true", args: [], env: { ...subject.env("plane_publish"), EXTRA_NOT_ALLOWED: "1" }, networkPolicy: [], timeoutMs: 10_000 };
      // the host engine has no publish sandbox, so a command is refused there for that reason first; the microVM engine checks its table
      await expect(subject.port.runCommand(handle, command)).rejects.toMatchObject({ code: differs("publishCalls") ? "env_not_clean" : "no_publish_sandbox" });
      // a refused job leaves the sandbox free for the next one
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject));
      expect((await hookFired)?.seq).toBe(1);
    });
  });
}
