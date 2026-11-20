import { afterEach, describe, expect, it } from "vitest";
import { daemonInventorySource } from "../../../src/vm/sandboxd/management.js";
import { CHECK_CLOSED, createLiveMicrovm, liveMicrovmComplete, type LiveMicrovmParts } from "../../../src/vm/sandboxd/live.js";
import type { EgressStarters } from "../../../src/vm/sandboxd/policyPort.js";
import { scriptedRuntime } from "../../sandboxPortContract.js";
import { makeRig, runCleanups, type Rig } from "./helpers.js";

afterEach(runCleanups);

const starters: EgressStarters = {
  startProxy: async () => ({ close: async () => undefined }),
  startReverse: async () => ({ close: async () => undefined }),
};

/** Every part, built over the rig's fake helper and guest agent (fakes at the host-fact and helper seams; the daemon, adapter and port are the real ones). */
function parts(rig: Rig, over: Partial<LiveMicrovmParts> = {}): LiveMicrovmParts {
  const { boot, ...deps } = rig.deps;
  return { deps, boot, template: "fx-agent", memMb: 256, uid: 4711, egress: starters, makeRuntime: () => scriptedRuntime(), ...over };
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
    for (const key of ["deps", "boot", "template", "memMb", "uid", "egress", "makeRuntime"] as const) {
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
});
