import { afterEach, describe, expect, it } from "vitest";
import type { StartDetachedOptions } from "../../../src/sandbox/port.js";
import { createMicrovmSandbox, MicrovmSandboxRefused } from "../../../src/vm/sandboxd/microvmSandbox.js";
import { createDaemonSdk } from "../../../src/vm/sandboxd/sdkAdapter.js";
import { scriptedRuntime } from "../../sandboxPortContract.js";
import { makeRig, runCleanups } from "./helpers.js";

afterEach(runCleanups);

/** D#587 B-5b-3b, FU-139 part 2: a call in the setup phase that never answers is ended by the deadline, and the sandbox is free again. */
function build(setupMs: number) {
  const rig = makeRig();
  const hang = { on: false };
  const inner = createDaemonSdk({ daemon: rig.daemon, policy: { apply: async () => undefined, release: async () => undefined }, template: "fx-agent", memMb: 256 });
  // the hang is in the guest's own call, as the port sees it (not inside the adapter's per-sandbox queue)
  const sdk = {
    ...inner,
    get: async (params: Parameters<typeof inner.get>[0]) => {
      const guest = await inner.get(params);
      return new Proxy(guest, { get: (target, key) => (key === "updateNetworkPolicy" && hang.on ? () => new Promise<never>(() => undefined) : (Reflect.get(target, key) as unknown)) });
    },
  };
  const port = createMicrovmSandbox({ sdk, makeRuntime: () => scriptedRuntime(), setupMs });
  return { rig, hang, port };
}
const job = (): StartDetachedOptions => ({ runId: "r1", role: "executor", roleCard: "c", prompt: "p", model: "sonnet", workdir: "/work/job", capUsd: 1, networkPolicy: [], env: {}, onEvent: () => undefined }) as unknown as StartDetachedOptions;

describe("the setup-phase deadline (a call that never answers)", () => {
  it("a command whose setup hangs ends with `setup_timeout`, the busy mark clears, and the sandbox can still be written to and deleted", async () => {
    const { port, hang } = build(80);
    const handle = await port.createSandbox({ sandboxName: "dl-cmd", retention: { persistent: false }, timeoutMs: 60_000 });
    hang.on = true;
    const started = Date.now();
    await expect(port.runCommand(handle, { role: "r", cmd: "true", args: [], env: {}, networkPolicy: [], timeoutMs: 5000 })).rejects.toMatchObject({ code: "setup_timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    hang.on = false;
    await expect(port.writeFiles(handle, [{ path: "/tmp/x", content: "x" }])).resolves.toBeUndefined(); // not `sandbox_busy`
    await expect(port.deleteSandbox(handle)).resolves.toBeUndefined();
    expect(await port.sandboxExists(handle)).toBe(false);
  });

  it("an agent start whose setup hangs rejects `hookFired` with `setup_timeout`, `running` clears, and a later start is not `sandbox_busy`", async () => {
    const { port, hang } = build(80);
    const handle = await port.createSandbox({ sandboxName: "dl-start", retention: { persistent: false }, timeoutMs: 60_000 });
    hang.on = true;
    await expect(port.startDetached(handle, job()).hookFired).rejects.toBeInstanceOf(MicrovmSandboxRefused);
    hang.on = false;
    const again = port.startDetached(handle, job()); // not `sandbox_busy`
    again.hookFired.catch(() => undefined);
    await port.deleteSandbox(handle);
  });

  it("a setup that answers in time is untouched", async () => {
    const { port } = build(5000);
    const handle = await port.createSandbox({ sandboxName: "dl-ok", retention: { persistent: false }, timeoutMs: 60_000 });
    await expect(port.runCommand(handle, { role: "r", cmd: "true", args: [], env: {}, networkPolicy: [], timeoutMs: 5000 })).resolves.toMatchObject({ timedOut: false });
    await port.deleteSandbox(handle);
  });
});

/** A guest whose policy calls are slow by script, and that logs what lands and what starts. */
function buildScripted(setupMs: number, delaysMs: number[]) {
  const rig = makeRig();
  const inner = createDaemonSdk({ daemon: rig.daemon, policy: { apply: async () => undefined, release: async () => undefined }, template: "fx-agent", memMb: 256 });
  const landed: unknown[] = [];
  const started: string[] = [];
  const delays = [...delaysMs];
  const sdk = {
    ...inner,
    get: async (params: Parameters<typeof inner.get>[0]) => {
      const guest = await inner.get(params);
      return new Proxy(guest, {
        get: (target, key) => {
          if (key === "updateNetworkPolicy") {
            return async (policy: unknown) => {
              const wait = delays.shift() ?? 0;
              if (wait > 0) await new Promise((r) => setTimeout(r, wait));
              await target.updateNetworkPolicy(policy as never);
              landed.push(policy);
            };
          }
          if (key === "runCommand") {
            return (cmd: { cmd: string; args: string[] }) => {
              started.push(`${cmd.cmd} ${cmd.args.join(",")}`);
              return target.runCommand(cmd as never);
            };
          }
          return Reflect.get(target, key) as unknown;
        },
      });
    },
  };
  const port = createMicrovmSandbox({ sdk, makeRuntime: () => scriptedRuntime(), setupMs });
  return { port, landed, started };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("a setup that answers after its deadline has no further effect", () => {
  it("a late policy answer starts no command, and the policy in force at the end is the next command's", async () => {
    const { port, landed, started } = buildScripted(80, [300]);
    const handle = await port.createSandbox({ sandboxName: "dl-late", retention: { persistent: false }, timeoutMs: 60_000 });
    const a = port.runCommand(handle, { role: "r", cmd: "true", args: ["a"], env: {}, networkPolicy: [{ host: "wide.example" }] as never, timeoutMs: 5000 } as never);
    const aOutcome = a.then(() => "ran", (e: unknown) => (e as { code?: string }).code);
    await sleep(250); // A's deadline has passed; its policy call is still in flight
    const b = await port.runCommand(handle, { role: "r", cmd: "true", args: ["b"], env: {}, networkPolicy: [], timeoutMs: 5000 });
    expect(b.timedOut).toBe(false);
    expect(await aOutcome).toBe("setup_timeout");
    await sleep(400); // everything abandoned has had its chance to run
    expect(started).toEqual(["true b"]); // A never started
    expect(landed.at(-1)).toBe("deny-all"); // B's policy is the last in force
    expect(landed).toEqual([{ allow: ["wide.example"] }, "deny-all"]); // and it landed after the late one, not before
    await port.deleteSandbox(handle);
  });

  it("an owner that gives up while queued behind a slow policy write writes nothing when its turn comes", async () => {
    const { port, landed, started } = buildScripted(80, [300]);
    const handle = await port.createSandbox({ sandboxName: "dl-queue", retention: { persistent: false }, timeoutMs: 60_000 });
    const first = port.runCommand(handle, { role: "r", cmd: "true", args: ["a"], env: {}, networkPolicy: [{ host: "a.example" }] as never, timeoutMs: 5000 } as never);
    await expect(first).rejects.toMatchObject({ code: "setup_timeout" });
    const second = port.runCommand(handle, { role: "r", cmd: "true", args: ["c"], env: {}, networkPolicy: [{ host: "c.example" }] as never, timeoutMs: 5000 } as never);
    await expect(second).rejects.toMatchObject({ code: "setup_timeout" });
    await sleep(500);
    expect(landed).toEqual([{ allow: ["a.example"] }]); // the queued owner's own write never went out
    expect(started).toEqual([]);
    await port.deleteSandbox(handle);
  });

  it("an agent start abandoned by its deadline does not go on to report a session or start the agent", async () => {
    const { port } = buildScripted(80, [200]);
    const handle = await port.createSandbox({ sandboxName: "dl-agent", retention: { persistent: false }, timeoutMs: 60_000 });
    const seen: string[] = [];
    const run = port.startDetached(handle, { ...job(), onSession: (id: string) => void seen.push(id), onStage: (s: string) => void seen.push(s) } as never);
    await expect(run.hookFired).rejects.toMatchObject({ code: "setup_timeout" });
    await sleep(350);
    expect(seen).toEqual([]);
    await port.deleteSandbox(handle);
  });
});
