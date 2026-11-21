import { afterEach, describe, expect, it } from "vitest";
import { daemonInventorySource } from "../../../src/vm/sandboxd/management.js";
import { CHECK_CLOSED, createLiveMicrovm, liveMicrovmComplete, type LiveMicrovmParts } from "../../../src/vm/sandboxd/live.js";
import type { EgressStarters } from "../../../src/vm/sandboxd/policyPort.js";
import { scriptedRuntime } from "../../sandboxPortContract.js";
import { GuestBindings, GuestRunHooks, type RunEventHooks } from "../../../src/vm/sandboxd/guestBindings.js";
import { makeRig, runCleanups, type Rig } from "./helpers.js";

afterEach(runCleanups);

const starters: EgressStarters = {
  startProxy: async () => ({ close: async () => undefined }),
  startReverse: async () => ({ close: async () => undefined }),
};

/** Every part, built over the rig's fake helper and guest agent (fakes at the host-fact and helper seams; the daemon, adapter and port are the real ones). */
function parts(rig: Rig, over: Partial<LiveMicrovmParts> = {}): LiveMicrovmParts {
  const { boot, ...deps } = rig.deps;
  return { deps, boot, template: "fx-agent", memMb: 256, uid: 4711, egress: starters, makeRuntime: () => scriptedRuntime(), bindings: new GuestBindings(), readToken: () => Buffer.from("t"), runHooks: new GuestRunHooks(), ...over };
}

describe("createLiveMicrovm: the whole stack or nothing", () => {
  it("every part present composes the port and the SDK it uses", () => {
    const live = createLiveMicrovm(parts(makeRig()));
    expect(live).toBeDefined();
    expect(typeof live?.port.createSandbox).toBe("function");
    expect(typeof live?.sdk.managed).toBe("function");
  });

  it("no parts at all, and each part left out in turn (including the guest runtime and the boot facts), is undefined", () => {
    const rig = makeRig();
    expect(createLiveMicrovm(undefined)).toBeUndefined();
    expect(createLiveMicrovm({})).toBeUndefined();
    for (const key of ["deps", "boot", "template", "memMb", "uid", "egress", "makeRuntime", "bindings", "readToken", "runHooks"] as const) {
      const without = { ...parts(rig), [key]: undefined };
      expect(createLiveMicrovm(without), key).toBeUndefined();
      expect(liveMicrovmComplete(without), key).toBe(false);
    }
  });

  it("a part that is present but unusable is the same as absent: an empty template, a zero or fractional RAM, a root or non-integer uid", () => {
    const rig = makeRig();
    for (const bad of [{ template: "" }, { memMb: 0 }, { memMb: 1.5 }, { uid: 0 }, { uid: 1.5 }, { uid: Number.NaN }]) expect(createLiveMicrovm(parts(rig, bad)), JSON.stringify(bad)).toBeUndefined();
  });

  it("a daemon that refuses to be built (run as root, no euid) leaves the build unwired, not half-built", () => {
    const rig = makeRig();
    expect(createLiveMicrovm({ ...parts(rig), deps: { ...parts(rig).deps!, euid: 0 } })).toBeUndefined();
    expect(createLiveMicrovm({ ...parts(rig), deps: { ...parts(rig).deps!, euid: undefined } })).toBeUndefined();
  });

  it("doctor and run agree for a root process: liveMicrovmComplete is false exactly when createLiveMicrovm refuses the euid", () => {
    const rig = makeRig();
    for (const euid of [0, undefined, -1, 1.5, Number.NaN]) {
      const refused = { ...parts(rig), deps: { ...parts(rig).deps!, euid } };
      expect(liveMicrovmComplete(refused), String(euid)).toBe(false);
      expect(createLiveMicrovm(refused), String(euid)).toBeUndefined();
    }
    const good = parts(rig);
    expect(liveMicrovmComplete(good)).toBe(true);
    expect(createLiveMicrovm(good)).toBeDefined();
  });

  it("a fake VM started through the port shows in the inventory under the daemon's id (sb- and 32 hex), never the run's own name, and leaves the next list when deleted", async () => {
    const live = createLiveMicrovm(parts(makeRig()))!;
    const source = daemonInventorySource(live.sdk);
    expect(await source.list()).toEqual([]);
    const handle = await live.port.createSandbox({ sandboxName: "rn-fix-branch-derived-name", retention: { persistent: false }, timeoutMs: 60_000 });
    const rows = await source.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toMatch(/^sb-[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain("branch-derived");
    await live.port.stop(handle);
    await live.port.deleteSandbox(handle);
    expect(await source.list()).toEqual([]);
  });

  it("the check is closed on the VM port with a fixed word and an interrupt is a no-op, until the fresh-VM check exists", async () => {
    const live = createLiveMicrovm(parts(makeRig()))!;
    const handle = await live.port.createSandbox({ sandboxName: "rn-closed", retention: { persistent: false }, timeoutMs: 60_000 });
    expect(live.port.checkLaunch(handle, ["pnpm", "test"], false)).toEqual({ refused: CHECK_CLOSED });
    await expect(live.port.interrupt(handle)).resolves.toBeUndefined();
    await live.port.deleteSandbox(handle);
  });

  it("the VM factory over the real daemon, adapter and port (fake helper and guest): egress and the guest are up after create, and release, stop, destroy and delete each leave nothing behind", async () => {
    let open = 0;
    const counting: EgressStarters = {
      startProxy: async () => (open++, { close: async () => void open-- }),
      startReverse: async () => (open++, { close: async () => void open-- }),
    };
    const runHooks = new GuestRunHooks();
    runHooks.attach(() => ({ onLocalEvent: () => undefined, onNearLimit: () => undefined }));
    const live = createLiveMicrovm(parts(makeRig(), { egress: counting, runHooks }))!;
    const source = daemonInventorySource(live.sdk);
    const bindings = new GuestBindings();
    const vm = live.vmPort({ timeoutMs: 60_000, runId: "run-a", bindings });
    await vm.create("rn-bound", "agent");
    expect(bindings.tokenOf("rn-bound")).toBeDefined();
    await vm.delete("rn-bound");
    expect(bindings.tokenOf("rn-bound")).toBeUndefined();
    await vm.create("rn-factory", "agent");
    await vm.create("rc-factory", "check");
    expect(open).toBe(4);
    for (const id of ["rn-factory", "rc-factory"]) {
      await vm.startEgress(id);
      await vm.waitGuest(id, new AbortController().signal);
    }
    expect(await source.list()).toHaveLength(2);
    // the agent's VM: listeners, then stop, then delete (a repeat is safe)
    await vm.releaseEgress("rn-factory");
    expect(open).toBe(2);
    await vm.stop("rn-factory");
    await expect(vm.startEgress("rn-factory")).rejects.toMatchObject({ code: "egress_down" });
    await vm.delete("rn-factory");
    await vm.delete("rn-factory");
    // the check VM: destroy (no snapshot) ends it too
    await vm.releaseEgress("rc-factory");
    await vm.destroy("rc-factory");
    expect(open).toBe(0);
    expect(await source.list()).toEqual([]);
  });
});

describe("the run's usage and relay sinks, and what startup reaping works over (D#587 3c-iii)", () => {
  const sinks = (runId: string, seen: string[]): RunEventHooks => ({ onLocalEvent: () => void seen.push(`event:${runId}`), onNearLimit: () => void seen.push(`near:${runId}`) });

  it("a VM made for a run is bound with that run's own sinks, found by the run id; the runtime's binding carries them and another run's VM gets its own", async () => {
    const seen: string[] = [];
    const runHooks = new GuestRunHooks();
    runHooks.attach((runId) => sinks(runId, seen));
    const live = createLiveMicrovm(parts(makeRig(), { runHooks }))!;
    const bindings = new GuestBindings();
    await live.vmPort({ timeoutMs: 60_000, runId: "run-a", bindings }).create("rn-a", "agent");
    await live.vmPort({ timeoutMs: 60_000, runId: "run-b", bindings }).create("rn-b", "agent");
    await bindings.binding({ name: "rn-a" } as never).onLocalEvent?.({} as never);
    bindings.binding({ name: "rn-b" } as never).onNearLimit?.({});
    expect(seen).toEqual(["event:run-a", "near:run-b"]);
  });

  it("with no sinks attached no VM is made: the refusal comes before the VM exists, so nothing is left to end and nothing is bound", async () => {
    const live = createLiveMicrovm(parts(makeRig()))!; // `parts` hands over a `GuestRunHooks` nobody attached to
    const bindings = new GuestBindings();
    await expect(live.vmPort({ timeoutMs: 60_000, runId: "run-a", bindings }).create("rn-x", "agent")).rejects.toThrow("guest_hooks_unattached");
    expect(await daemonInventorySource(live.sdk).list()).toEqual([]);
    expect(bindings.tokenOf("rn-x")).toBeUndefined();
  });

  it("the reap source is the HELPER's list, so a VM an earlier process left is seen by a new stack, and ending it by id leaves nothing; an id the helper never knew is done", async () => {
    const rig = makeRig();
    const earlier = createLiveMicrovm(parts(rig))!;
    await earlier.port.createSandbox({ sandboxName: "rn-left-behind", retention: { persistent: false }, timeoutMs: 60_000 });
    const later = createLiveMicrovm(parts(rig))!; // the next process: same helper, a daemon with an empty table
    expect(await daemonInventorySource(later.sdk).list()).toEqual([]);
    const ids = await later.reap.list();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^sb-[0-9a-f]{32}$/);
    await later.reap.port.releaseEgress(ids[0]!);
    await later.reap.port.delete(ids[0]!);
    expect(await later.reap.list()).toEqual([]);
    await expect(later.reap.port.delete(ids[0]!)).resolves.toBeUndefined();
  });
});
