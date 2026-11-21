import { describe, expect, it } from "vitest";
import { createMicrovmVmPort, VmPortRefused, type MicrovmVmPortParts } from "../../../src/vm/sandboxd/vmPort.js";

const SENTINEL = "/home/sentinel-user/secret-repo";

function rig(over: { state?: string; guestFails?: boolean; createFails?: boolean; teardown?: boolean; persistent?: boolean } = {}) {
  const log: string[] = [];
  const parts: MicrovmVmPortParts = {
    sandbox: {
      async createSandbox(opts) {
        log.push(`create ${opts.sandboxName} persistent=${String(opts.retention.persistent)} timeout=${String(opts.timeoutMs)}`);
        if (over.createFails === true) throw new Error(`${SENTINEL} refused`);
        return { runId: "", sandboxName: opts.sandboxName, sessionId: "s1" };
      },
      async stop(handle) {
        log.push(`stop ${handle.sandboxName}`);
      },
      async deleteSandbox(handle) {
        log.push(`delete ${handle.sandboxName}`);
      },
      async guestOf(handle) {
        log.push(`guest ${handle.sandboxName}`);
        if (over.guestFails === true) throw new Error(`${SENTINEL} not running`);
        return { name: handle.sandboxName } as never;
      },
      async sandboxState(handle) {
        log.push(`state ${handle.sandboxName}`);
        return (over.state ?? "running") as never;
      },
    },
    daemon: { teardown: async (id) => (log.push(`teardown ${id}`), over.teardown !== false), get: async (id) => (log.push(`get ${id}`), {} as never) },
    bindings: { bind: (name) => (log.push(`bind ${name}`), {} as never), unbind: (name) => void log.push(`unbind ${name}`) },
    policy: { release: async (id) => void log.push(`release ${id}`) },
    idOf: (name) => `id-${name}`,
    timeoutMs: 123_000,
    ...(over.persistent === undefined ? {} : { persistent: over.persistent }),
  };
  return { port: createMicrovmVmPort(parts), log };
}

describe("the production VmPort", () => {
  it("create makes the VM through the microVM port by name, with the port's limit, non-persistent unless the wiring says otherwise", async () => {
    const r = rig();
    await r.port.create("rn-1", "agent");
    await r.port.create("rc-1", "check");
    expect(r.log).toEqual(["create rn-1 persistent=false timeout=123000", "get id-rn-1", "bind rn-1", "create rc-1 persistent=false timeout=123000", "get id-rc-1", "bind rc-1"]);
  });

  it("the daemon's handle is bound by name when a VM is created and unbound when it is deleted or destroyed (and a repeat is safe)", async () => {
    const r = rig();
    await r.port.create("rn-1", "agent");
    await r.port.create("rc-1", "check");
    await r.port.delete("rn-1");
    await r.port.destroy("rc-1");
    await r.port.delete("rn-1");
    expect(r.log.filter((l) => l.startsWith("bind") || l.startsWith("unbind"))).toEqual(["bind rn-1", "bind rc-1", "unbind rn-1", "unbind rc-1", "unbind rn-1"]);
  });

  it("only the agent's VM is ever persistent: the check VM never keeps a snapshot", async () => {
    const r = rig({ persistent: true });
    await r.port.create("rn-1", "agent");
    await r.port.create("rc-1", "check");
    expect(r.log.filter((l) => l.startsWith("create"))).toEqual(["create rn-1 persistent=true timeout=123000", "create rc-1 persistent=false timeout=123000"]);
  });

  it("a create that fails passes the failure on and leaves nothing to end but the name the caller registered (delete by name still works)", async () => {
    const r = rig({ createFails: true });
    await expect(r.port.create("rn-1", "agent")).rejects.toThrow();
    await r.port.delete("rn-1");
    expect(r.log.at(-2)).toBe("delete rn-1");
  });

  it("startEgress is a check, not a second path: egress is up (the VM is running with its closed policy in force) or it refuses with one fixed word", async () => {
    const up = rig();
    await up.port.create("rn-1", "agent");
    await expect(up.port.startEgress("rn-1")).resolves.toBeUndefined();
    for (const state of ["stopped", "gone", "unknown"]) {
      const down = rig({ state });
      await down.port.create("rn-1", "agent");
      await expect(down.port.startEgress("rn-1"), state).rejects.toMatchObject({ code: "egress_down" });
    }
  });

  it("waitGuest needs a running guest and an unaborted signal; a failure carries one fixed word and nothing the port said", async () => {
    const ok = rig();
    await ok.port.create("rn-1", "agent");
    await expect(ok.port.waitGuest("rn-1", new AbortController().signal)).resolves.toBeUndefined();
    const bad = rig({ guestFails: true });
    await bad.port.create("rn-1", "agent");
    const refusal = await bad.port.waitGuest("rn-1", new AbortController().signal).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(VmPortRefused);
    expect(JSON.stringify([(refusal as Error).message, (refusal as VmPortRefused).code])).not.toContain(SENTINEL);
    const stopped = new AbortController();
    stopped.abort();
    await expect(ok.port.waitGuest("rn-1", stopped.signal)).rejects.toBeDefined();
  });

  it("releaseEgress closes the listeners by the daemon's id, not the name; stop is the port's stop", async () => {
    const r = rig();
    await r.port.create("rn-1", "agent");
    await r.port.releaseEgress("rn-1");
    await r.port.stop("rn-1");
    expect(r.log.slice(3)).toEqual(["release id-rn-1", "stop rn-1"]);
  });

  it("destroy of a VM that was never persistent ends it through the port's delete: no snapshot exists to keep", async () => {
    const r = rig();
    await r.port.create("rn-1", "agent");
    await r.port.destroy("rn-1");
    expect(r.log.slice(3)).toEqual(["delete rn-1", "unbind rn-1"]);
  });

  it("destroy of a persistent VM is the daemon's no-snapshot teardown, which keeps earlier snapshots: never a delete, and never a stop", async () => {
    const r = rig({ persistent: true });
    await r.port.create("rn-1", "agent");
    await r.port.destroy("rn-1");
    expect(r.log.slice(3)).toEqual(["teardown id-rn-1", "release id-rn-1", "unbind rn-1"]);
  });

  it("a destroy the helper did not finish is refused with one fixed word, so the registry keeps the VM as a leftover", async () => {
    const r = rig({ persistent: true, teardown: false });
    await r.port.create("rn-1", "agent");
    await expect(r.port.destroy("rn-1")).rejects.toMatchObject({ code: "vm_not_gone" });
  });

  it("delete ends the VM and is safe to repeat, also for a name this port never made", async () => {
    const r = rig();
    await r.port.create("rn-1", "agent");
    await r.port.delete("rn-1");
    await r.port.delete("rn-1");
    await r.port.delete("rn-never-made");
    expect(r.log.slice(3).filter((l) => l.startsWith("delete"))).toEqual(["delete rn-1", "delete rn-1", "delete rn-never-made"]);
  });
});
