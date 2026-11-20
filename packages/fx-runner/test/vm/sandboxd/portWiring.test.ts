import { afterEach, describe, expect, it } from "vitest";
import type { SdkCreateParams } from "@fx/runner";
import { daemonInventorySource, daemonSandboxLifecycle } from "../../../src/vm/sandboxd/management.js";
import { createEgressPolicyPort, type EgressListener, type EgressStarters } from "../../../src/vm/sandboxd/policyPort.js";
import { createDaemonSdk, type PolicyPort } from "../../../src/vm/sandboxd/sdkAdapter.js";
import type { HelperEntry } from "../../../src/vm/sandboxd/helperClient.js";
import { makeRig, runCleanups } from "./helpers.js";

afterEach(runCleanups);

const UID = 4711;
const creds = { teamId: "t", projectId: "p", token: "tok" };
const params = (name: string, over: Partial<SdkCreateParams> = {}): SdkCreateParams => ({ name, image: `fx-agent@sha256:${"d".repeat(64)}`, timeout: 60_000, persistent: false, resources: { vcpus: 1 }, tags: {}, networkPolicy: "deny-all", ...creds, ...over });

/** Starters that write what happens to a log, with a gate and failure switches. */
function fakeEgress(log: string[], over: { failReverse?: boolean; failProxy?: boolean; gate?: Promise<void>; failClose?: string } = {}): { starters: EgressStarters; started: Array<{ kind: string; options: Record<string, unknown> }> } {
  const started: Array<{ kind: string; options: Record<string, unknown> }> = [];
  const listener = (kind: string): EgressListener => ({
    close: async () => {
      log.push(`close ${kind}`);
      if (over.failClose === kind) throw new Error("close failed");
    },
  });
  return {
    started,
    starters: {
      startProxy: async (o) => {
        if (over.failProxy === true) throw new Error("refused");
        started.push({ kind: "proxy", options: { ...o } });
        log.push("start proxy");
        return listener("proxy");
      },
      startReverse: async (o) => {
        await over.gate;
        if (over.failReverse === true) throw new Error("refused");
        started.push({ kind: "reverse", options: { ...o } });
        log.push("start reverse");
        return listener("reverse");
      },
    },
  };
}
const entry = (id: string, gid = 4242): HelperEntry => ({ sandboxId: id, vsockDir: `/jail/vsock/${id}`, sandboxGid: gid });
const helperOf = (...entries: HelperEntry[]) => ({ list: async () => entries });

describe("the egress policy port", () => {
  it("starts the proxy and the reverse endpoint on the sandbox's own directory, always with its gid and the policy as given", async () => {
    const log: string[] = [];
    const { starters, started } = fakeEgress(log);
    const port: PolicyPort = createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a", 4242), entry("sb-b", 9)), egress: starters });
    await port.apply("sb-a", { allow: { "registry.npmjs.org": [] } });
    expect(log).toEqual(["start proxy", "start reverse"]);
    for (const s of started) expect(s.options).toEqual({ vsockDir: "/jail/vsock/sb-a", sandboxId: "sb-a", sandboxGid: 4242, uid: UID, policy: { allow: { "registry.npmjs.org": [] } } });
  });

  it("a sandbox the helper does not list, or lists without a gid, starts nothing", async () => {
    const log: string[] = [];
    const { starters } = fakeEgress(log);
    const port = createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a"), { sandboxId: "sb-x", vsockDir: "/d/sb-x" } as never), egress: starters });
    await expect(port.apply("sb-nope", "deny-all")).rejects.toMatchObject({ code: "unknown_sandbox" });
    await expect(port.apply("sb-x", "deny-all")).rejects.toMatchObject({ code: "no_gid" });
    expect(log).toEqual([]);
  });

  it("a new policy closes the old listeners before it starts the new ones", async () => {
    const log: string[] = [];
    const port = createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: fakeEgress(log).starters });
    await port.apply("sb-a", "deny-all");
    await port.apply("sb-a", "deny-all");
    expect(log).toEqual(["start proxy", "start reverse", "close proxy", "close reverse", "start proxy", "start reverse"]);
  });

  it("if the second listener cannot start the first is closed and apply fails; if the first cannot, the second is never tried", async () => {
    const log: string[] = [];
    const reverseFails = createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: fakeEgress(log, { failReverse: true }).starters });
    await expect(reverseFails.apply("sb-a", "deny-all")).rejects.toThrow("refused");
    expect(log).toEqual(["start proxy", "close proxy"]);
    await reverseFails.release("sb-a");
    expect(log).toEqual(["start proxy", "close proxy"]);
    const proxyFails = fakeEgress([], { failProxy: true });
    await expect(createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: proxyFails.starters }).apply("sb-a", "deny-all")).rejects.toThrow("refused");
    expect(proxyFails.started).toEqual([]);
  });

  it("release closes both even when one close fails; the failed one is kept and the next release closes it", async () => {
    const log: string[] = [];
    let failing = true;
    const base = fakeEgress(log).starters;
    const starters: EgressStarters = {
      startProxy: async (o) => {
        const l = await base.startProxy(o);
        return { close: async () => (failing ? Promise.reject(new Error("close failed")) : l.close()) };
      },
      startReverse: base.startReverse,
    };
    const port = createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: starters });
    await port.apply("sb-a", "deny-all");
    await expect(port.release("sb-a")).rejects.toThrow("close failed");
    expect(log.slice(2)).toEqual(["close reverse"]); // the other one was still closed
    failing = false;
    await expect(port.release("sb-a")).resolves.toBeUndefined();
    expect(log.slice(2)).toEqual(["close reverse", "close proxy"]); // retried, and only the one that was left
    await expect(port.release("sb-a")).resolves.toBeUndefined();
    expect(log).toHaveLength(4);
  });

  it("a policy change whose close fails starts nothing new and keeps the failed listener for the retry", async () => {
    const log: string[] = [];
    const port = createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: fakeEgress(log, { failClose: "proxy" }).starters });
    await port.apply("sb-a", "deny-all");
    await expect(port.apply("sb-a", "deny-all")).rejects.toThrow("close failed");
    expect(log.filter((l) => l.startsWith("start"))).toEqual(["start proxy", "start reverse"]); // no second start
  });

  it("a lookup that fails on a policy change leaves nothing listening: the old listeners are closed first", async () => {
    const log: string[] = [];
    let down = false;
    const helper = { list: async () => (down ? Promise.reject(new Error("helper down")) : [entry("sb-a")]) };
    const port = createEgressPolicyPort({ uid: UID, helper, egress: fakeEgress(log).starters });
    await port.apply("sb-a", { allow: ["registry.npmjs.org"] });
    down = true;
    await expect(port.apply("sb-a", "deny-all")).rejects.toThrow("helper down");
    expect(log).toEqual(["start proxy", "start reverse", "close proxy", "close reverse"]);
    await port.release("sb-a"); // nothing left to close
    expect(log).toHaveLength(4);
    down = false;
    await expect(createEgressPolicyPort({ uid: UID, helper: helperOf(), egress: fakeEgress([]).starters }).apply("sb-a", "deny-all")).rejects.toMatchObject({ code: "unknown_sandbox" });
  });

  it("an apply and a release for one id never overlap", async () => {
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const port = createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: fakeEgress(log, { gate }).starters });
    const applying = port.apply("sb-a", "deny-all");
    const releasing = port.release("sb-a");
    await new Promise((r) => setTimeout(r, 40));
    expect(log).toEqual(["start proxy"]);
    open();
    await Promise.all([applying, releasing]);
    expect(log).toEqual(["start proxy", "start reverse", "close proxy", "close reverse"]);
  });

  it("host-side credentials are handed to the reverse endpoint only, and only when configured", async () => {
    const { starters, started } = fakeEgress([]);
    const inject = (host: string): Record<string, string> => ({ "x-host": host });
    await createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: starters, inject: () => inject }).apply("sb-a", "deny-all");
    expect(started.find((s) => s.kind === "reverse")?.options["inject"]).toBe(inject);
    expect(started.find((s) => s.kind === "proxy")?.options).not.toHaveProperty("inject");
    const plain = fakeEgress([]);
    await createEgressPolicyPort({ uid: UID, helper: helperOf(entry("sb-a")), egress: plain.starters }).apply("sb-a", "deny-all");
    expect(plain.started.find((s) => s.kind === "reverse")?.options).not.toHaveProperty("inject");
  });
});

describe("the policy is in force before any command runs", () => {
  it("the listeners are up before the guest sees an exec; stop and delete close them; a wake closes them again then opens a closed policy", async () => {
    const rig = makeRig();
    const log: string[] = [];
    const { starters, started } = fakeEgress(log);
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: createEgressPolicyPort({ uid: UID, helper: rig.deps.helper, egress: starters }), template: "fx-agent", memMb: 256 });
    const sandbox = await sdk.create(params("ex-order", { networkPolicy: { allow: { "registry.npmjs.org": [] } } }));
    const agent = [...rig.agents.values()][0];
    expect(log).toEqual(["start proxy", "start reverse"]);
    expect(agent?.execs ?? []).toEqual([]);
    const gid = process.getgid?.();
    expect(started.map((s) => s.options["sandboxGid"])).toEqual([gid, gid]);
    const command = await sandbox.runCommand({ cmd: "true", detached: true });
    expect((await command.wait()).exitCode).toBe(0);

    await sandbox.stop();
    expect(log.slice(2)).toEqual(["close proxy", "close reverse"]);
    await sdk.get({ name: "ex-order", resume: true, ...creds });
    expect(started.at(-1)?.options["policy"]).toBe("deny-all");
    expect(log.slice(4)).toEqual(["start proxy", "start reverse"]);
    await (await sdk.get({ name: "ex-order", resume: false, ...creds })).delete();
    expect(log.slice(6)).toEqual(["close proxy", "close reverse"]);
  });

  it("while the listeners are still starting, commands and files are refused, and none reaches the guest", async () => {
    const rig = makeRig();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: createEgressPolicyPort({ uid: UID, helper: rig.deps.helper, egress: fakeEgress([], { gate }).starters }), template: "fx-agent", memMb: 256 });
    const creating = sdk.create(params("ex-gated"));
    await new Promise((r) => setTimeout(r, 200));
    const early = await sdk.get({ name: "ex-gated", resume: false, ...creds });
    await expect(early.runCommand({ cmd: "true", detached: true })).rejects.toMatchObject({ response: { status: 409 } });
    expect([...rig.agents.values()][0]?.execs ?? []).toEqual([]);
    open();
    await creating;
  });

  it("a policy the listeners cannot start leaves no sandbox and no listener", async () => {
    const rig = makeRig();
    const log: string[] = [];
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: createEgressPolicyPort({ uid: UID, helper: rig.deps.helper, egress: fakeEgress(log, { failReverse: true }).starters }), template: "fx-agent", memMb: 256 });
    await expect(sdk.create(params("ex-bad"))).rejects.toMatchObject({ response: { status: 502 } });
    expect(rig.helper.entries.size).toBe(0);
    expect(log).toEqual(["start proxy", "close proxy"]);
  });
});

describe("inventory and lifecycle on the daemon", () => {
  const setup = () => {
    const rig = makeRig();
    const sdk = createDaemonSdk({ daemon: rig.daemon, policy: { apply: async () => undefined, release: async () => undefined }, template: "fx-agent", memMb: 256 });
    return { rig, sdk };
  };

  it("lists each sandbox by its daemon id, with the protocol's fields, newest first, and nothing it did not measure as a figure", async () => {
    const { sdk } = setup();
    await sdk.create(params("ex-one"));
    const two = await sdk.create(params("ex-two"));
    await two.stop();
    const rows = await daemonInventorySource(sdk).list();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.name).toMatch(/^sb-[0-9a-f]{32}$/);
      expect(row.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(row).toMatchObject({ disk_bytes: 0, snapshot_count: 0, snapshot_age_s: null });
    }
    expect(rows.map((r) => r.state).sort()).toEqual(["running", "stopped"]);
    expect(JSON.stringify(rows)).not.toContain("ex-one");
  });

  it("stop and delete are done for a name that is not there, and act on one that is", async () => {
    const { sdk, rig } = setup();
    const life = daemonSandboxLifecycle(sdk);
    expect(await life.stop("sb-0000")).toEqual({ ok: true });
    expect(await life.delete("sb-0000")).toEqual({ ok: true });
    await sdk.create(params("ex-one"));
    const name = (await daemonInventorySource(sdk).list())[0]!.name;
    expect(await life.stop(name)).toEqual({ ok: true });
    expect((await daemonInventorySource(sdk).list())[0]?.state).toBe("stopped");
    expect(await life.delete(name)).toEqual({ ok: true });
    expect(await daemonInventorySource(sdk).list()).toEqual([]);
    expect(rig.helper.entries.size).toBe(0);
    await expect(sdk.get({ name: "ex-one", resume: false, ...creds })).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("reap deletes the stopped sandboxes and never a running one", async () => {
    const { sdk, rig } = setup();
    const a = await sdk.create(params("ex-a"));
    await sdk.create(params("ex-b"));
    await a.stop();
    expect(await daemonSandboxLifecycle(sdk).reapStopped()).toEqual({ ok: true });
    const rows = await daemonInventorySource(sdk).list();
    expect(rows.map((r) => r.state)).toEqual(["running"]);
    expect(rig.helper.entries.size).toBe(1);
  });

  it("a reap never deletes a sandbox that a queued wake has just brought up", async () => {
    const { sdk, rig } = setup();
    const sandbox = await sdk.create(params("ex-wakes"));
    await sandbox.stop();
    const waking = sdk.get({ name: "ex-wakes", resume: true, ...creds }); // queued ahead of the reap, not awaited
    expect(await daemonSandboxLifecycle(sdk).reapStopped()).toEqual({ ok: true });
    const woken = await waking;
    expect(woken.status).toBe("running");
    expect(rig.helper.entries.size).toBe(1);
    expect((await daemonInventorySource(sdk).list()).map((r) => r.state)).toEqual(["running"]);
    await expect(woken.runCommand({ cmd: "true", detached: true })).resolves.toBeDefined();
  });

  it("a sandbox that is still being created is in use, and a helper that fails is a fixed failure", async () => {
    const { sdk, rig } = setup();
    let open!: () => void;
    rig.helper.holdPrepare = new Promise<void>((r) => (open = r));
    const creating = sdk.create(params("ex-busy"));
    await new Promise((r) => setTimeout(r, 100));
    const name = (await daemonInventorySource(sdk).list())[0]!.name;
    expect(await daemonSandboxLifecycle(sdk).stop(name)).toEqual({ ok: false, refusal: "in_use" });
    open();
    await creating;
    rig.helper.refuse.set("destroy", "internal");
    expect(await daemonSandboxLifecycle(sdk).stop(name)).toEqual({ ok: false, refusal: "failed" });
  });

  it("more than 200 sandboxes list the newest 200, so the block is never refused whole", async () => {
    const rows = Array.from({ length: 230 }, (_, i) => ({ id: `sb-${i}`, state: "running" as const, createdAtMs: 1_700_000_000_000 + i, lastUsedAtMs: 1_700_000_000_000 }));
    const list = await daemonInventorySource({ managed: () => rows }).list();
    expect(list).toHaveLength(200);
    expect(list[0]?.name).toBe("sb-229");
    expect(list.at(-1)?.name).toBe("sb-30");
  });
});
