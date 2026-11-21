import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVmClaimGuard, createVmJobDeps, runEventHooks, type VmJobWiring } from "../../src/daemon/vmJobDeps.js";
import { createEventRelay } from "../../src/daemon/lease.js";
import { createUsageGate } from "../../src/daemon/usageGate.js";
import type { JobHandlerDeps } from "../../src/daemon/jobHandler.js";
import { VmRegistry } from "../../src/vm/jobLifecycle.js";
import { idOfRunner, sandboxIdOf, runnerIdPrefix } from "../../src/vm/sandboxd/sdkAdapter.js";
import type { MicrovmCaps } from "../../src/vm/limits.js";
import { GuestBindings } from "../../src/vm/sandboxd/guestBindings.js";
import type { LiveMicrovm } from "../../src/vm/sandboxd/live.js";

/**
 * D#587 B-5b-3c-iii: `deps.vm` of the job handler, joined over the live stack. The live stack here is a fake (named so): the pieces it joins have their own suites, and the real
 * composition through `run` is `test/commands/run.test.ts` and the dispatched real-VM run. What is proven here is the join itself.
 */
let root: string;
beforeEach(() => void (root = mkdtempSync(path.join(tmpdir(), "fxr-vmjobdeps-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const CAPS: MicrovmCaps = { maxVms: 2, maxVcpus: 4, maxMemoryMb: 4096, snapshotDir: "/var/lib/fx/snap", snapshotQuotaBytes: 10 ** 12 };
const SENTINEL = "sentinel-token-for-the-join-test";

function fakeLive(calls: string[] = []) {
  const bindings = new GuestBindings();
  const reads = { n: 0 };
  const guest = { name: "g" };
  const live = {
    crossing: { bind: () => undefined, unbind: () => undefined, collect: async () => null, makeRuntime: () => ({}) },
    guestOf: async (handle: { sandboxName: string }) => (calls.push(`guestOf:${handle.sandboxName}`), guest),
    quiesce: async (handle: { sandboxName: string }) => void calls.push(`quiesce:${handle.sandboxName}`),
    vmPort: (options: { timeoutMs: number; runId: string }) => (calls.push(`vmPort:${options.timeoutMs}:${options.runId}`), { tag: `port-${options.timeoutMs}` }),
    memMb: 512,
    bindings,
    readToken: () => (reads.n++, Buffer.from(SENTINEL)),
  } as unknown as LiveMicrovm;
  return { live, bindings, reads, guest, calls };
}

function wiring(over: Partial<VmJobWiring> & { live: LiveMicrovm }): VmJobWiring {
  const capture = async () => ({ code: 1, stdout: "", timedOut: false });
  return { stateDir: root, capture, now: () => new Date(0), caps: () => CAPS, readMemAvailableBytes: () => 8 * 1024 ** 3, subscription: true, ...over };
}

describe("the join over the live stack", () => {
  it("the crossing is the stack's own, and the guest reads and the quiet point go to the stack's port by sandbox name", async () => {
    const { live, calls, guest } = fakeLive();
    const vm = createVmJobDeps(wiring({ live }));
    expect(vm.crossing).toBe(live.crossing);
    const handle = { runId: "", sandboxName: "rn-1", sessionId: "" };
    expect(await vm.guestOf(handle)).toBe(guest);
    await vm.quiesce(handle);
    expect(calls).toEqual(["guestOf:rn-1", "quiesce:rn-1"]);
  });

  it("every job gets a VM factory made for its own limit, and the deps hold one teardown table, empty at the start", () => {
    const { live, calls } = fakeLive();
    const vm = createVmJobDeps(wiring({ live }));
    const port = vm.lifecycle.port as (options: { timeoutMs: number; runId: string }) => unknown;
    expect(port({ timeoutMs: 1000, runId: "run-1" })).toEqual({ tag: "port-1000" });
    expect(port({ timeoutMs: 7_800_000, runId: "run-2" })).toEqual({ tag: "port-7800000" });
    expect(calls).toEqual(["vmPort:1000:run-1", "vmPort:7800000:run-2"]);
    expect(vm.lifecycle.registry.ids()).toEqual([]);
  });

  it("the limits are read at each use, so a change is seen at the next job and the request is one vCPU at the stack's RAM", () => {
    const { live } = fakeLive();
    let caps: MicrovmCaps | undefined = CAPS;
    const vm = createVmJobDeps(wiring({ live, caps: () => caps }));
    expect(vm.lifecycle.caps).toEqual(CAPS);
    caps = { ...CAPS, maxVms: 1 };
    expect(vm.lifecycle.caps?.maxVms).toBe(1);
    caps = undefined;
    expect(vm.lifecycle.caps).toBeUndefined();
    expect(vm.lifecycle.request).toEqual({ vcpus: 1, memoryMb: 512 });
    expect(vm.lifecycle.readMemAvailableBytes()).toBe(8 * 1024 ** 3);
  });

  it("the token step is made only for a subscription run, over the stack's bindings and reader; building the deps reads no token and the slot reads it only when it delivers", async () => {
    const { live, bindings, reads } = fakeLive();
    const sent: Buffer[] = [];
    bindings.bind("rn-1", { deliverToken: async (t: Buffer) => void sent.push(Buffer.from(t)), wipeToken: async () => undefined } as never);
    const vm = createVmJobDeps(wiring({ live }));
    expect(reads.n).toBe(0);
    expect(vm.lifecycle.token?.needed({} as never)).toBe(true);
    const slot = vm.lifecycle.token?.slot("rn-1");
    expect(reads.n).toBe(0);
    await slot?.deliver(new AbortController().signal);
    expect(reads.n).toBe(1);
    expect(sent.map(String)).toEqual([SENTINEL]);
    await expect(vm.lifecycle.token?.slot("rn-unbound")?.deliver(new AbortController().signal)).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(createVmJobDeps(wiring({ live, subscription: false })).lifecycle.token?.needed({} as never)).toBe(false);
  });

  it("an archive and a bundle apply work in one 0700 scratch directory under the state directory, made at first use; a link in its place is refused, never followed", async () => {
    const { live } = fakeLive();
    const vm = createVmJobDeps(wiring({ live }));
    const scratch = path.join(root, "vm-scratch");
    expect(() => lstatSync(scratch)).toThrow(); // not made until a job needs it
    await expect(vm.archive(path.join(root, "no-repo"), "z".repeat(40))).rejects.toBeDefined(); // a bad commit id is refused, nothing is built
    await expect(vm.archive(path.join(root, "no-repo"), "a".repeat(40))).rejects.toBeDefined(); // the fake git fails: the closed refusal
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    chmodSync(scratch, 0o755);
    await expect(vm.archive(path.join(root, "no-repo"), "a".repeat(40))).rejects.toBeDefined();
    expect(statSync(scratch).mode & 0o777).toBe(0o700); // tightened, not trusted

    const elsewhere = mkdtempSync(path.join(tmpdir(), "fxr-vmjobdeps-else-"));
    try {
      const other = mkdtempSync(path.join(tmpdir(), "fxr-vmjobdeps-state-"));
      symlinkSync(elsewhere, path.join(other, "vm-scratch"));
      const linked = createVmJobDeps(wiring({ live, stateDir: other }));
      await expect(linked.archive("/fictional/repo", "a".repeat(40))).rejects.toThrow("vm_scratch_not_a_directory");
      await expect(linked.apply({ bundle: Buffer.alloc(1), base: "a".repeat(40), mirrorDir: "/fictional/mirror", workspace: "/fictional/work" })).rejects.toThrow("vm_scratch_not_a_directory");
      expect(readdirSync(elsewhere)).toEqual([]); // nothing was written through the link
      rmSync(other, { recursive: true, force: true });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("the approved check is the fresh-VM check over the stack's guest reads: a check that needs a Nix dev shell is refused in the VM with the closed reason", async () => {
    const { live } = fakeLive();
    const vm = createVmJobDeps(wiring({ live }));
    const outcome = await vm.freshCheck?.({ check: { argv: ["true"], dev_shell: true, timeout_s: 5 } } as never, { runId: "", sandboxName: "rc-1", sessionId: "" });
    expect(outcome).toMatchObject({ passed: false, body: { reason: "sandbox_refused" } });
  });
});

describe("a VM run's guest events go where the OS-sandbox path's go (spend and usage-limit reporting)", () => {
  const limitEvent = { type: "usage_limit_reached", reset_at: new Date(Date.now() + 3_600_000).toISOString() } as never;
  const usageEvent = { type: "usage", seq: 1 } as never;
  const rig = (mode: "subscription" | "api_key" = "subscription") => {
    const clock = { t: Date.now() };
    const usage = createUsageGate({ credentialMode: mode, now: () => clock.t, random: () => 0 });
    const relay = createEventRelay();
    const seen: Array<[string, unknown]> = [];
    const detach = (runId: string) => relay.attach(runId, (event) => void seen.push([runId, event]));
    return { usage, relay, seen, detach, hooksFor: runEventHooks({ usage, relay }) };
  };

  it("an event reaches the usage gate and that run's relay sink; another run's sink sees nothing of it", () => {
    const r = rig();
    r.detach("run-a");
    r.detach("run-b");
    r.hooksFor("run-a").onLocalEvent(usageEvent);
    expect(r.seen).toEqual([["run-a", usageEvent]]);
    expect(r.relay.dropped()).toBe(0);
    r.hooksFor("run-gone").onLocalEvent(usageEvent); // no sink: counted as dropped, as for the host engine
    expect(r.relay.dropped()).toBe(1);
  });

  it("usage_limit_reached blocks every claim at the gate, and a near-limit warning holds the runner to one job", () => {
    const r = rig();
    expect(r.usage.state()).toEqual({ blocked: false, single: false });
    r.hooksFor("run-a").onNearLimit({});
    expect(r.usage.state()).toEqual({ blocked: false, single: true });
    r.hooksFor("run-a").onLocalEvent(limitEvent);
    expect(r.usage.state().blocked).toBe(true);
  });
});

const RUNNER_HOME = "/tmp/fictional-runner-home-a";
const OWN = idOfRunner(runnerIdPrefix(RUNNER_HOME));

describe("the claim loop's part of the microVM path", () => {
  const apiKey = () => createVmClaimGuard({ ...guardRig({ subscription: false }) });
  function guardRig(over: { subscription?: boolean; listed?: string[]; deleteFails?: string[]; listFails?: boolean; maxVms?: number } = {}) {
    const calls: string[] = [];
    const state = { listed: over.listed ?? [], deleteFails: new Set(over.deleteFails ?? []), listFails: over.listFails === true };
    const live = {
      idPrefix: runnerIdPrefix(RUNNER_HOME),
      idOf: OWN,
      reap: {
        list: async () => {
          calls.push("list");
          if (state.listFails) throw new Error("helper down");
          return [...state.listed];
        },
        port: {
          releaseEgress: async (id: string) => void calls.push(`release:${id}`),
          delete: async (id: string) => {
            calls.push(`delete:${id}`);
            if (state.deleteFails.has(id)) throw new Error("stuck");
            state.listed = state.listed.filter((x) => x !== id);
          },
        },
      },
    } as unknown as LiveMicrovm;
    const registry = new VmRegistry();
    const vm = { lifecycle: { registry, caps: { ...CAPS, maxVms: over.maxVms ?? 2 } } } as unknown as NonNullable<JobHandlerDeps["vm"]>;
    return { live, vm, subscription: over.subscription ?? true, calls, state, registry };
  }

  it("an API-key runner claims nothing, with a named local reason", () => {
    expect(apiKey().block()).toBe("microvm_api_key_unsupported");
  });

  it("nothing is claimed before the startup reap has run; once it is clean the claim is open", async () => {
    const r = guardRig();
    const guard = createVmClaimGuard(r);
    expect(guard.block()).toBe("vm_reap_pending");
    await guard.start();
    expect(guard.block()).toBeUndefined();
  });

  it("a VM an earlier process left is ended before the first claim (egress released, then the VM deleted); a failed end holds claiming, and the next claim check tries again", async () => {
    const left = OWN("rn-left");
    const stuck = OWN("rn-stuck");
    const r = guardRig({ listed: [left, stuck], deleteFails: [stuck] });
    const guard = createVmClaimGuard(r);
    await guard.start();
    expect(r.calls).toEqual(["list", `release:${left}`, `delete:${left}`, `release:${stuck}`, `delete:${stuck}`]);
    expect(guard.block()).toBe("vm_reap_pending"); // still held: and this check started another pass
    r.state.deleteFails.clear();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(guard.block()).toBeUndefined();
    expect(r.state.listed).toEqual([]);
  });

  it("the startup reap is called with this runner's own prefix: another runner's VMs and unmarked ones are listed and left alone", async () => {
    const other = idOfRunner(runnerIdPrefix("/tmp/fictional-runner-home-b"))("rn-theirs");
    const unmarked = sandboxIdOf("rn-unmarked");
    const mine = OWN("rn-mine");
    const r = guardRig({ listed: [mine, other, unmarked] });
    await createVmClaimGuard(r).start();
    expect(r.calls).toEqual(["list", `release:${mine}`, `delete:${mine}`]);
    expect(r.state.listed).toEqual([other, unmarked]);
  });

  it("a live job registered by name is not reaped on a pass that finds its mapped id in the list", async () => {
    const r = guardRig({ listed: [OWN("rn-live"), OWN("rn-orphan")] });
    r.registry.add("rn-live", "agent", { vcpus: 1, memoryMb: 512 });
    await createVmClaimGuard(r).start();
    expect(r.calls).toEqual(["list", `release:${OWN("rn-orphan")}`, `delete:${OWN("rn-orphan")}`]);
    expect(r.state.listed).toEqual([OWN("rn-live")]);
  });

  it("a helper list that cannot be read holds claiming: what is left is unknown", async () => {
    const r = guardRig({ listFails: true });
    const guard = createVmClaimGuard(r);
    await guard.start();
    expect(guard.block()).toBe("vm_reap_pending");
    await new Promise((resolve) => setTimeout(resolve, 10)); // the check above started a pass that failed the same way
    expect(guard.block()).toBe("vm_reap_pending");
    await new Promise((resolve) => setTimeout(resolve, 10));
    r.state.listFails = false;
    expect(guard.block()).toBe("vm_reap_pending"); // this check starts the pass that can now read the list
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(guard.block()).toBeUndefined();
  });

  it("the VM cap holds claiming, on the lifecycle's own registry: at the cap no claim is made, below it the claim is open, and a stopped VM holds no RAM so it does not count", async () => {
    const r = guardRig({ maxVms: 2 });
    const guard = createVmClaimGuard(r);
    await guard.start();
    r.registry.add("rn-1", "agent", { vcpus: 1, memoryMb: 512 });
    expect(guard.block()).toBeUndefined();
    r.registry.add("rc-1", "check", { vcpus: 1, memoryMb: 512 });
    expect(guard.block()).toBe("vm_cap_reached");
    r.registry.markStopped("rc-1");
    expect(guard.block()).toBeUndefined();
  });
});
