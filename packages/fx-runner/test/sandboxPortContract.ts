import { describe, expect, it } from "vitest";
import type { AgentHandle, AgentRuntime, NormalizedEvent, StartOptions } from "@fulcrumaxe/runner-protocol";
import { SandboxNotFoundError } from "@fx/runner";
import type { SandboxHandle, SandboxPort, StartDetachedOptions } from "../src/sandbox/port.js";

/**
 * D#6 C1 section 2: the one contract suite for `SandboxPort`. It holds port semantics only, so it runs unchanged against
 * every adapter: `fakeSandbox`, the host tier in `@fulcrumaxe/fx-runner`, and the container and microVM tiers later.
 * What differs by adapter (the env a start must carry, how a deleted sandbox is made unresumable) comes from the
 * subject; nothing in the assertions below is specific to one of them.
 */
export interface ContractSubject {
  port: SandboxPort;
  /** The env this adapter requires on a start (the fake wants the hosted placeholders, a local tier its clean env). */
  env(role: string): Record<string, string>;
  /** An absolute directory the adapter accepts as the job's working directory. */
  workdir: string;
  /** For an adapter whose delete alone does not make `resume` fail (the fake only fails when told to). */
  afterDelete?(handle: SandboxHandle): void;
  /** The sandbox's current wall-clock limit, for an adapter that can say; the suite then checks `extendTimeout` moved it. */
  timeoutMsOf?(handle: SandboxHandle): number | undefined;
}

/** What an adapter is, as opposed to what one instance of it is built from. Known when the suite is declared, so a case can be skipped by name. */
export interface ContractTraits {
  /**
   * True for an adapter whose agent runtime reports how a run ended through `handle.done` (the local engine does; a hosted
   * tier learns it from the hook event). Such an adapter must not turn a failed outcome into a clean or empty end. For any
   * other adapter that case does not apply and shows as skipped.
   */
  reportsOutcomes?: boolean;
}

const event = (seq: number, type: NormalizedEvent["type"]): NormalizedEvent => ({ runId: "run-1", role: "executor", seq, type, ts: "2026-10-08T00:00:00.000Z" });

/**
 * An agent runtime the suite scripts, in the shape of the local engine: `start` emits `events` through `onEvent` (awaiting
 * each) and resolves with a handle once the process exists; `handle.done` settles when the run ends, at once or after
 * `release()` (which `stop` also calls).
 */
export function scriptedRuntime(script: { events?: NormalizedEvent[]; hold?: boolean; done?: unknown } = {}): AgentRuntime & { release(): void; stopped(): number } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stops = 0;
  async function run(onEvent: StartOptions["onEvent"], runId: string): Promise<{ handle: AgentHandle }> {
    for (const e of script.events ?? [event(0, "system"), event(1, "result")]) await onEvent(e);
    return { handle: { runId, done: script.done ?? (script.hold ? gate : Promise.resolve()) } };
  }
  return {
    start: (opts) => run(opts.onEvent, opts.runId),
    stop: async () => {
      stops += 1;
      release();
    },
    resume: async (handle) => ({ handle }),
    release: () => release(),
    stopped: () => stops,
  };
}

export function describeSandboxPortContract(name: string, factory: (runtime: AgentRuntime) => ContractSubject, traits: ContractTraits = {}): void {
  const sandboxOpts = (n: string) => ({ sandboxName: n, retention: { persistent: false }, timeoutMs: 60_000 });
  const startOpts = (subject: ContractSubject, over: Partial<StartDetachedOptions> = {}): StartDetachedOptions => ({
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
  const pending = async (promise: Promise<unknown>): Promise<boolean> => (await Promise.race([promise.then(() => false, () => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 40))]));

  describe(`SandboxPort contract: ${name}`, () => {
    it("startDetached returns synchronously, with a hookFired promise", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("c-sync"));
      const result = subject.port.startDetached(handle, startOpts(subject));
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.hookFired).toBeInstanceOf(Promise);
      await result.hookFired;
    });

    it("hookFired resolves with the run's terminal event, after every event reached onEvent in order", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("c-terminal"));
      const seen: number[] = [];
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject, { onEvent: (e) => void seen.push(e.seq) }));
      expect((await hookFired)?.seq).toBe(1);
      expect(seen).toEqual([0, 1]);
    });

    it("hookFired rejects, and does not hang, when onEvent aborts the run by throwing", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("c-abort"));
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject, { onEvent: () => { throw new Error("spend kill"); } }));
      await expect(hookFired).rejects.toThrow("spend kill");
    });

    it("hookFired stays pending while the run is going and settles when it ends", async () => {
      const runtime = scriptedRuntime({ hold: true });
      const subject = factory(runtime);
      const handle = await subject.port.createSandbox(sandboxOpts("c-pending"));
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject));
      expect(await pending(hookFired)).toBe(true);
      runtime.release();
      expect((await hookFired)?.seq).toBe(1);
    });

    it.skipIf(traits.reportsOutcomes !== true)("a failed outcome rejects hookFired with the engine's reason as `code`, for an adapter that reports outcomes", async () => {
      const failed = { status: "failed", failureReason: "credential_mismatch", engineVersion: "2.1.289" };
      const subject = factory(scriptedRuntime({ events: [], done: Promise.resolve(failed) }));
      const handle = await subject.port.createSandbox(sandboxOpts("c-failed"));
      const error = await subject.port.startDetached(handle, startOpts(subject)).hookFired.then(() => undefined, (e: unknown) => e);
      expect((error as { code?: string } | undefined)?.code).toBe("credential_mismatch");
      const clean = factory(scriptedRuntime({ events: [], done: Promise.resolve({ status: "ok", engineVersion: "2.1.289" }) }));
      const cleanHandle = await clean.port.createSandbox(sandboxOpts("c-ok"));
      await expect(clean.port.startDetached(cleanHandle, startOpts(clean)).hookFired).resolves.toBeUndefined();
    });

    it("stop ends a running run, and is idempotent: twice, before any start, and after delete", async () => {
      const runtime = scriptedRuntime({ hold: true });
      const subject = factory(runtime);
      const handle = await subject.port.createSandbox(sandboxOpts("c-stop"));
      await subject.port.stop(handle);
      const { hookFired } = subject.port.startDetached(handle, startOpts(subject));
      await subject.port.stop(handle);
      await subject.port.stop(handle);
      await hookFired;
      await subject.port.deleteSandbox(handle);
      await expect(subject.port.stop(handle)).resolves.toBeUndefined();
    });

    it("deleteSandbox is idempotent", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("c-delete"));
      await subject.port.deleteSandbox(handle);
      await expect(subject.port.deleteSandbox(handle)).resolves.toBeUndefined();
    });

    it("resume on a live sandbox runs and settles", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("c-resume"));
      const { hookFired } = subject.port.resume(handle, "sess-1", "carry on", startOpts(subject));
      await hookFired;
    });

    it("resume on a deleted sandbox throws SandboxNotFoundError", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("c-gone"));
      await subject.port.deleteSandbox(handle);
      subject.afterDelete?.(handle);
      let thrown: unknown;
      try {
        subject.port.resume(handle, "sess-1", "carry on", startOpts(subject));
      } catch (error) {
        thrown = error;
      }
      // The real error class lives in the cloud package; the structural copy has the same name and field.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe(SandboxNotFoundError.name);
      expect((thrown as SandboxNotFoundError).sandboxName).toBe("c-gone");
    });

    it("extendTimeout resolves, and moves the limit for an adapter that reports one", async () => {
      const subject = factory(scriptedRuntime());
      const handle = await subject.port.createSandbox(sandboxOpts("c-extend"));
      const before = subject.timeoutMsOf?.(handle);
      await expect(subject.port.extendTimeout(handle, 5_000)).resolves.toBeUndefined();
      if (subject.timeoutMsOf !== undefined) expect(subject.timeoutMsOf(handle)).toBe((before ?? 0) + 5_000);
    });
  });
}
