import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { JobToken, JobTokenError, withJobToken, type TokenSandbox } from "../../../src/vm/sandboxd/jobToken.js";
import { makeRig, runCleanups } from "./helpers.js";

afterEach(runCleanups);

/** D#587 B-5b-3c: the job token module over the real Sandboxd, the real frames and the guest agent fake of #1102's tests. */
const sentinel = (): Buffer => Buffer.from(`sk-ant-oat01-${randomBytes(24).toString("hex")}`);
const persistent = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512, retention: { persistent: true } });
type Rig = ReturnType<typeof makeRig>;
const verbs = (rig: Rig): unknown[] => rig.helper.frames.map((f) => f["verb"]);
const zeroed = (b: Buffer): boolean => b.every((x) => x === 0);
const tokenOps = (rig: Rig, name: string): string[] => (rig.agents.get(name)?.ops ?? []).filter((o) => o.startsWith("token_"));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const text = (err: unknown): string => JSON.stringify(err) + String((err as Error).message) + String((err as Error).stack);
const fakeSandbox = (over: Partial<TokenSandbox> = {}): TokenSandbox => ({
  deliverToken: async (t) => void t.fill(0),
  wipeToken: async () => undefined,
  runCommand: async () => undefined as never,
  runStream: async () => undefined as never,
  stop: async () => undefined,
  delete: async () => undefined,
  ...over,
});

async function setup(name = "alpha", over: Parameters<typeof makeRig>[0] = {}) {
  const rig = makeRig(over);
  const sb = await rig.daemon.create(persistent(name));
  return { rig, sb, agent: rig.agents.get(name)!, jt: new JobToken(sb) };
}

describe("delivery and launch", () => {
  it("delivers once, launches only with the token as the ordinary user, and no argv or env carries a byte of it", async () => {
    const { agent, jt } = await setup();
    const token = sentinel();
    const copy = Buffer.from(token);
    await jt.deliver(() => token);
    expect(agent.token).toEqual(copy);
    expect(zeroed(token)).toBe(true);
    await (await jt.launch({ cmd: "true", env: { A: "b" } })).wait();
    expect(agent.execTokenFlags).toEqual([true]);
    expect(JSON.stringify(agent.execs)).not.toContain(copy.toString().slice(0, 16));
  });

  it("a launch cannot ask for root or drop the token flag: the module's values win", async () => {
    const seen: unknown[] = [];
    const jt = new JobToken(fakeSandbox({ runCommand: async (s) => (seen.push(s), undefined as never) }));
    await jt.deliver(sentinel);
    await jt.launch({ cmd: "x", user: "root", withToken: false } as never);
    expect(seen[0]).toMatchObject({ withToken: true, user: "ubuntu" });
  });

  it("launchStream: the same pins as launch (the token flag on, the ordinary user), whatever the caller asks for", async () => {
    const seen: unknown[] = [];
    const jt = new JobToken(fakeSandbox({ runStream: async (s) => (seen.push(s), undefined as never) }));
    await jt.deliver(sentinel);
    await jt.launchStream({ id: "cli-1", cmd: "x", args: ["a"], env: { A: "b" }, stdin: Buffer.from("prompt"), timeoutS: 9, user: "root", withToken: false } as never);
    expect(seen[0]).toMatchObject({ id: "cli-1", cmd: "x", args: ["a"], env: { A: "b" }, timeoutS: 9, withToken: true, user: "ubuntu" });
  });

  it("launchStream: refused before a delivery, during a wipe, after one and once a wipe is unconfirmed, and nothing reaches the guest", async () => {
    const seen: unknown[] = [];
    let failWipe = false;
    const jt = new JobToken(fakeSandbox({ runStream: async (s) => (seen.push(s), undefined as never), wipeToken: async () => { if (failWipe) throw new Error("x"); } }));
    await expect(jt.launchStream({ id: "a-1", cmd: "x" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await jt.deliver(sentinel);
    const wiping = jt.wipe();
    await expect(jt.launchStream({ id: "a-2", cmd: "x" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await wiping;
    await expect(jt.launchStream({ id: "a-3", cmd: "x" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await jt.deliver(sentinel);
    failWipe = true;
    await expect(jt.wipe()).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    await expect(jt.launchStream({ id: "a-4", cmd: "x" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(seen).toEqual([]);
  });

  it("refuses a launch before a delivery, during a wipe and after one, and sends nothing to the guest", async () => {
    const { agent, jt } = await setup();
    await expect(jt.launch({ cmd: "true" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await jt.deliver(sentinel);
    const wiping = jt.wipe();
    await expect(jt.launch({ cmd: "true" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await wiping;
    await expect(jt.launch({ cmd: "true" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(agent.execs).toEqual([]);
  });

  it("a delivery that fails is wiped at once, ends with the fixed code, and the buffer is zeroed", async () => {
    const { rig, agent, jt } = await setup();
    agent.refuseTokenPut = true;
    const token = sentinel();
    const err = await jt.deliver(() => token).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(JobTokenError);
    expect(err).toMatchObject({ code: "vm_token_delivery_failed" });
    expect(zeroed(token)).toBe(true);
    expect(tokenOps(rig, "alpha")).toEqual(["token_put", "token_wipe", "token_wipe"]); // the refused put, the daemon's own wipe, then ours: the one whose confirmation we see
    await jt.stop(); // the wipe was confirmed, so a stop is allowed
  });

  it("an empty read, a throwing read and an already aborted signal deliver nothing and wipe nothing", async () => {
    const { rig, jt } = await setup();
    await expect(jt.deliver(() => Buffer.alloc(0))).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await expect(jt.deliver(() => { throw new Error("no key"); })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    const ac = new AbortController();
    ac.abort();
    const token = sentinel();
    await expect(jt.deliver(() => token, ac.signal)).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(tokenOps(rig, "alpha")).toEqual([]);
  });

  it("an abort while the put is in flight gives up, waits for the put to land, wipes it, and leaves no token", async () => {
    const { rig, agent, jt } = await setup();
    let release!: () => void;
    agent.holdTokenPut = new Promise<void>((r) => (release = r));
    const ac = new AbortController();
    const token = sentinel();
    const delivery = jt.deliver(() => token, ac.signal).then(() => undefined, (e: unknown) => e);
    await wait(50);
    ac.abort();
    await wait(50);
    release();
    expect(await delivery).toMatchObject({ code: "vm_token_delivery_failed" });
    expect(tokenOps(rig, "alpha")).toEqual(["token_put", "token_wipe"]);
    expect(agent.token).toBeUndefined();
    expect(zeroed(token)).toBe(true);
  });

  it("a put that never answers ends by the deadline and is wiped (a plain fake sandbox, so the timing is the module's own)", async () => {
    let wiped = 0;
    const jt = new JobToken(fakeSandbox({ deliverToken: () => new Promise<void>(() => undefined), wipeToken: async () => void wiped++ }), { deliverMs: 40 });
    const token = sentinel();
    await expect(jt.deliver(() => token)).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(wiped).toBe(1);
    expect(zeroed(token)).toBe(true); // given up on while the put still hangs: our copy is gone now, not when it settles
  });
});

describe("the wipe on every way out", () => {
  it("withJobToken wipes after a normal return", async () => {
    const { rig, agent, jt } = await setup();
    const out = await withJobToken(jt, sentinel, async (t) => { await (await t.launch({ cmd: "true" })).wait(); return 7; });
    expect(out).toBe(7);
    expect(tokenOps(rig, "alpha")).toEqual(["token_put", "token_wipe"]);
    expect(agent.token).toBeUndefined();
  });

  it("withJobToken wipes after the run throws, and the run's own error is what comes out", async () => {
    const { rig, jt } = await setup();
    await expect(withJobToken(jt, sentinel, async () => { throw new RangeError("agent failed"); })).rejects.toBeInstanceOf(RangeError);
    expect(tokenOps(rig, "alpha")).toEqual(["token_put", "token_wipe"]);
  });

  it("withJobToken wipes after an abort and after a timeout of the run", async () => {
    for (const how of ["abort", "timeout"] as const) {
      const { rig, jt } = await setup(`n-${how}`);
      const ac = new AbortController();
      const run = async (): Promise<void> => {
        if (how === "abort") await new Promise<void>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error("aborted"))));
        else await wait(30).then(() => { throw new Error("timeout"); });
      };
      const p = withJobToken(jt, sentinel, run, ac.signal).then(() => undefined, (e: unknown) => e);
      if (how === "abort") { await wait(50); ac.abort(); }
      expect(String(await p)).toMatch(/aborted|timeout/);
      expect(tokenOps(rig, `n-${how}`), how).toEqual(["token_put", "token_wipe"]);
    }
  });

  it("withJobToken on a failed delivery ends with the delivery code and the guest holds nothing", async () => {
    const { agent, jt } = await setup();
    agent.refuseTokenPut = true;
    await expect(withJobToken(jt, sentinel, async () => 1)).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    expect(agent.token).toBeUndefined();
  });

  it("stop wipes first: the helper snapshots a guest with no token, and the sandbox's own wipe is not repeated", async () => {
    const { rig, sb, agent, jt } = await setup();
    await jt.deliver(sentinel);
    let held: Buffer | undefined = Buffer.from("not read");
    const original = rig.helper.onSnapshot;
    rig.helper.onSnapshot = (id, snap, dir) => { held = rig.agents.get(id)?.token; original(id, snap, dir); };
    await jt.stop();
    expect(held).toBeUndefined();
    expect(verbs(rig)).toEqual(["prepare", "start", "snapshot"]);
    expect(sb.status).toBe("stopped");
    expect(agent.ops.filter((o) => o.startsWith("token_"))).toEqual(["token_put", "token_wipe"]);
  });

  it("no wipe is asked for when nothing was delivered, and two at once are one", async () => {
    const { rig, jt } = await setup();
    await jt.wipe();
    expect(tokenOps(rig, "alpha")).toEqual([]);
    await jt.deliver(sentinel);
    await Promise.all([jt.wipe(), jt.wipe()]);
    expect(tokenOps(rig, "alpha")).toEqual(["token_put", "token_wipe"]);
  });
});

describe("a wipe that is not confirmed", () => {
  it("blocks the stop and the snapshot: the VM is deleted, never stopped, and the code is vm_teardown_incomplete", async () => {
    const { rig, sb, agent, jt } = await setup();
    await jt.deliver(sentinel);
    agent.refuseTokenWipe = true;
    await expect(jt.stop()).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    expect(verbs(rig)).toEqual(["prepare", "start", "destroy"]);
    expect(rig.helper.snapshots.size).toBe(0);
    expect(() => sb.status).toThrow(); // deleted: the record is gone, not stopped
  });

  it("withJobToken reports the wipe failure over a successful run and over a failed one", async () => {
    for (const runFails of [false, true]) {
      const { agent, jt } = await setup(runFails ? "f" : "s");
      agent.refuseTokenWipe = true;
      await expect(withJobToken(jt, sentinel, async () => { if (runFails) throw new Error("agent failed"); })).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    }
  });

  it("latches: no launch and no delivery while blocked, and a later confirmed wipe unblocks it", async () => {
    const { agent, jt } = await setup();
    await jt.deliver(sentinel);
    agent.refuseTokenWipe = true;
    await expect(jt.wipe()).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    await expect(jt.launch({ cmd: "true" })).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await expect(jt.deliver(sentinel)).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    agent.refuseTokenWipe = false;
    await jt.wipe();
    await jt.deliver(sentinel); // a resume delivers again
  });

  it("a delivery whose wipe also fails stays latched, and stop deletes", async () => {
    const { rig, agent, jt } = await setup();
    agent.refuseTokenPut = true;
    agent.refuseTokenWipe = true;
    await expect(jt.deliver(sentinel)).rejects.toMatchObject({ code: "vm_token_delivery_failed" });
    await expect(jt.stop()).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    expect(verbs(rig)).not.toContain("snapshot");
  });

  it("a wipe that never answers is unconfirmed by the deadline (a plain fake sandbox): delete is called, stop is not", async () => {
    const calls: string[] = [];
    const jt = new JobToken(fakeSandbox({ wipeToken: () => new Promise<void>(() => undefined), stop: async () => void calls.push("stop"), delete: async () => void calls.push("delete") }), { wipeMs: 40 });
    await jt.deliver(sentinel);
    await expect(jt.stop()).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
    expect(calls).toEqual(["delete"]);
  });

  it("a failed delete does not hide the fixed code", async () => {
    const jt = new JobToken(fakeSandbox({ wipeToken: async () => { throw new Error("x"); }, delete: async () => { throw new Error("helper down"); } }));
    await jt.deliver(sentinel);
    await expect(jt.stop()).rejects.toMatchObject({ code: "vm_teardown_incomplete" });
  });
});

describe("what a failure says", () => {
  it("every error carries only a fixed code: no byte of the token, no cause", async () => {
    const { agent, jt } = await setup();
    const token = sentinel();
    const needle = token.toString().slice(0, 16);
    agent.refuseTokenPut = true;
    agent.refuseTokenWipe = true;
    const errs: unknown[] = [];
    errs.push(await jt.deliver(() => token).then(() => undefined, (e: unknown) => e));
    errs.push(await jt.wipe().then(() => undefined, (e: unknown) => e));
    errs.push(await jt.stop().then(() => undefined, (e: unknown) => e));
    for (const e of errs) {
      expect(e).toBeInstanceOf(JobTokenError);
      expect(text(e)).not.toContain(needle);
      expect((e as Error).cause).toBeUndefined();
      expect((e as Error).message).toBe((e as JobTokenError).code);
    }
  });
});

describe("Sandboxd.wipeToken", () => {
  it("waits for a delivery in flight, then wipes; an unknown or stopped sandbox is refused", async () => {
    const { rig, sb, agent } = await setup();
    let release!: () => void;
    agent.holdTokenPut = new Promise<void>((r) => (release = r));
    const delivery = sb.deliverToken(sentinel());
    await wait(50);
    const wiping = sb.wipeToken();
    await wait(100);
    expect(tokenOps(rig, "alpha")).toEqual(["token_put"]);
    release();
    await delivery;
    await wiping;
    expect(tokenOps(rig, "alpha")).toEqual(["token_put", "token_wipe"]);
    await expect(rig.daemon.wipeToken("nobody")).rejects.toMatchObject({ status: 404 });
    await sb.stop();
    await expect(sb.wipeToken()).rejects.toMatchObject({ status: 409, code: "not_running" });
  });

  it("a delivery still pending past the bound, or a guest that refuses, is token_wipe_failed", async () => {
    const rig = makeRig({ extra: { startWaitMs: 100 } });
    const sb = await rig.daemon.create(persistent("alpha"));
    const agent = rig.agents.get("alpha")!;
    let release!: () => void;
    agent.holdTokenPut = new Promise<void>((r) => (release = r));
    const delivery = sb.deliverToken(sentinel()).catch(() => undefined);
    await wait(30);
    await expect(sb.wipeToken()).rejects.toMatchObject({ status: 502, code: "token_wipe_failed" });
    release();
    await delivery;
    agent.refuseTokenWipe = true;
    await expect(sb.wipeToken()).rejects.toMatchObject({ code: "token_wipe_failed" });
  });
});
