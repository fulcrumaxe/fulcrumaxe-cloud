import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, TOKEN_MAX_BYTES, createGuestAgent, viaFirecrackerVsock } from "../../../src/vm/sandboxd/guestAgent.js";
import { makeRig, runCleanups, scratch } from "./helpers.js";

afterEach(runCleanups);

/** D#587 B-6.4, host side: the token goes to the guest's tmpfs through the agent, is wiped before any snapshot, and is never in a header, an error or a kept buffer. */
const sentinel = (): Buffer => Buffer.from(`sk-ant-oat01-${randomBytes(24).toString("hex")}`);
const persistent = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512, retention: { persistent: true } });
const verbs = (rig: ReturnType<typeof makeRig>): unknown[] => rig.helper.frames.map((f) => f["verb"]);
const zeroed = (b: Buffer): boolean => b.every((x) => x === 0);

/** A guest that records every byte it is sent, for a look at the wire. */
function recordingGuest(reply: object = { ok: true }): { file: string; received: Buffer[]; connects: () => number } {
  const file = path.join(scratch(), "g.sock");
  const received: Buffer[] = [];
  let connects = 0;
  const server = net.createServer((sock) => {
    connects++;
    sock.on("error", () => undefined);
    let hello = false;
    sock.on("data", (c) => {
      if (!hello) {
        hello = true;
        sock.write("OK 1\n");
        return;
      }
      received.push(c);
      const all = Buffer.concat(received);
      if (all.length < 4) return;
      const n = all.readUInt32BE(0);
      const size = (JSON.parse(all.subarray(4, 4 + n).toString()) as { size?: number }).size ?? 0;
      if (all.length < 4 + n + size) return;
      const body = Buffer.from(JSON.stringify(reply));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      sock.write(Buffer.concat([len, body]));
    });
  });
  server.listen(file);
  return { file, received, connects: () => connects };
}

describe("putToken on the wire", () => {
  it("sends one header with only the op and the size, then the token's raw bytes, and zeroes the caller's buffer", async () => {
    const guest = recordingGuest();
    const agent = createGuestAgent(viaFirecrackerVsock(guest.file), 2000);
    const token = sentinel();
    const copy = Buffer.from(token);
    await agent.putToken(token);
    const wire = Buffer.concat(guest.received);
    const n = wire.readUInt32BE(0);
    expect(JSON.parse(wire.subarray(4, 4 + n).toString())).toEqual({ op: "token_put", size: copy.length });
    expect(wire.subarray(4 + n)).toEqual(copy);
    expect(zeroed(token)).toBe(true);
  });

  it("refuses an empty, over-long, spaced, newline or non-ASCII token before it connects, and still zeroes the buffer", async () => {
    const guest = recordingGuest();
    const agent = createGuestAgent(viaFirecrackerVsock(guest.file), 2000);
    for (const bad of [Buffer.alloc(0), Buffer.alloc(TOKEN_MAX_BYTES + 1, "a"), Buffer.from("has space"), Buffer.from("line\nbreak"), Buffer.from("café-token"), Buffer.from("nul\0byte")]) {
      await expect(agent.putToken(bad)).rejects.toMatchObject({ code: "bad_request" });
      expect(zeroed(bad), `${bad.length} bytes`).toBe(true);
    }
    expect(guest.connects()).toBe(0);
    await agent.putToken(Buffer.alloc(TOKEN_MAX_BYTES, "a")); // the bound itself is allowed
    expect(guest.connects()).toBe(1);
  });

  it("a guest that refuses gives one fixed error that names no byte of the token, and the buffer is zeroed", async () => {
    const guest = recordingGuest({ ok: false, code: "secret_dir_unsafe" });
    const agent = createGuestAgent(viaFirecrackerVsock(guest.file), 2000);
    const token = sentinel();
    const text = token.toString();
    const err = await agent.putToken(token).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(JSON.stringify(err) + String((err as Error).message) + String((err as Error).stack)).not.toContain(text.slice(0, 16));
    expect((err as AgentError).code).toBe("refused");
    expect(zeroed(token)).toBe(true);
  });

  it("a guest that cannot be reached gives an error and a zeroed buffer", async () => {
    const agent = createGuestAgent(async () => { throw new Error("no route"); }, 300);
    const token = sentinel();
    await expect(agent.putToken(token)).rejects.toBeInstanceOf(Error);
    expect(zeroed(token)).toBe(true);
  });
});

describe("the daemon and the token", () => {
  it("delivers the token to a running sandbox, and a command can ask for it; nothing else carries it", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 1, memMb: 256 });
    const token = sentinel();
    const copy = Buffer.from(token);
    await sb.deliverToken(token);
    const agent = rig.agents.get("alpha")!;
    expect(agent.token).toEqual(copy);
    expect(zeroed(token)).toBe(true);
    await (await sb.runCommand({ cmd: "true", withToken: true })).wait();
    await (await sb.runCommand({ cmd: "true" })).wait();
    expect(agent.execTokenFlags).toEqual([true, false]);
    // argv carries no byte of the token
    expect(JSON.stringify(agent.execs)).not.toContain(copy.toString().slice(0, 16));
  });

  it("a command that asks for the token as root is refused before anything is sent, and one as the ordinary user is not", async () => {
    const guest = recordingGuest();
    const agent = createGuestAgent(viaFirecrackerVsock(guest.file), 2000);
    await expect(agent.runInGuest({ argv: ["true"], token: true, user: "root" })).rejects.toMatchObject({ code: "bad_request" });
    expect(guest.connects()).toBe(0);
    const rig = makeRig();
    const sb = await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 1, memMb: 256 });
    const fake = rig.agents.get("alpha")!;
    await expect(sb.runCommand({ cmd: "true", withToken: true, user: "root" })).rejects.toMatchObject({ code: "bad_request" });
    expect(fake.execs).toEqual([]);
    await (await sb.runCommand({ cmd: "true", withToken: true, user: "ubuntu" })).wait();
    expect(fake.execTokenFlags).toEqual([true]);
  });

  it("a sandbox that is not running refuses the delivery and the buffer is zeroed", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 1, memMb: 256 });
    await sb.stop();
    const token = sentinel();
    await expect(sb.deliverToken(token)).rejects.toMatchObject({ status: 409, code: "not_running" });
    expect(zeroed(token)).toBe(true);
    await expect(rig.daemon.deliverToken("nobody", sentinel())).rejects.toMatchObject({ status: 404 });
  });

  it("a snapshot stop wipes the guest first: the guest holds no token when the helper is asked to snapshot", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    await sb.deliverToken(sentinel());
    let heldAtSnapshot: Buffer | undefined = Buffer.from("not read");
    let opsAtSnapshot: string[] = [];
    const original = rig.helper.onSnapshot;
    rig.helper.onSnapshot = (id, snap, dir) => {
      heldAtSnapshot = rig.agents.get(id)?.token;
      opsAtSnapshot = [...(rig.agents.get(id)?.ops ?? [])];
      original(id, snap, dir);
    };
    await sb.stop();
    expect(heldAtSnapshot).toBeUndefined();
    expect(opsAtSnapshot.filter((o) => o === "token_put" || o === "token_wipe")).toEqual(["token_put", "token_wipe"]);
    expect(verbs(rig)).toEqual(["prepare", "start", "snapshot"]);
    expect(sb.status).toBe("stopped");
  });

  it("a wipe is asked only for a sandbox that was given a token, and only once per delivery", async () => {
    const rig = makeRig();
    const plain = await rig.daemon.create(persistent("plain"));
    const plainAgent = rig.agents.get("plain")!;
    await plain.stop();
    expect(plainAgent.ops.includes("token_wipe")).toBe(false);
    const given = await rig.daemon.create(persistent("given"));
    const agent = rig.agents.get("given")!;
    await given.deliverToken(sentinel());
    await given.stop();
    expect(agent.ops.filter((o) => o === "token_wipe")).toHaveLength(1);
    await rig.daemon.get("given", { resume: true });
    const resumed = rig.agents.get("given")!;
    await given.stop(); // the restored guest was given nothing: no second wipe
    expect(resumed.ops.filter((o) => o === "token_wipe")).toHaveLength(0);
  });

  it("a wipe the guest does not confirm means no snapshot: the VM is destroyed, nothing is kept, and the error is one fixed code", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    await sb.deliverToken(sentinel());
    rig.agents.get("alpha")!.refuseTokenWipe = true;
    const err = await sb.stop().then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "token_wipe_failed" });
    expect(String((err as Error).message)).not.toMatch(/sk-ant/);
    expect(verbs(rig)).toEqual(["prepare", "start", "destroy"]); // never a snapshot verb
    expect(rig.helper.snapshots.size).toBe(0);
    expect(sb.status).toBe("stopped");
    await expect(rig.daemon.get("alpha", { resume: true })).rejects.toMatchObject({ status: 404 }); // nothing to resume from
  });

  it("a delivery that fails is wiped at once, and the sandbox is then snapshotted without a second wipe", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    const agent = rig.agents.get("alpha")!;
    agent.refuseTokenPut = true;
    const token = sentinel();
    await expect(sb.deliverToken(token)).rejects.toBeInstanceOf(AgentError);
    expect(zeroed(token)).toBe(true);
    expect(agent.ops.filter((o) => o === "token_wipe")).toHaveLength(1);
    await sb.stop();
    expect(agent.ops.filter((o) => o === "token_wipe")).toHaveLength(1);
    expect(verbs(rig)).toEqual(["prepare", "start", "snapshot"]);
  });

  it("a failed delivery whose wipe also fails keeps the sandbox marked, so a snapshot stop wipes again and is refused", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    const agent = rig.agents.get("alpha")!;
    agent.refuseTokenPut = true;
    agent.refuseTokenWipe = true;
    await expect(sb.deliverToken(sentinel())).rejects.toBeInstanceOf(AgentError);
    await expect(sb.stop()).rejects.toMatchObject({ code: "token_wipe_failed" });
    expect(verbs(rig)).not.toContain("snapshot");
  });

  it("a snapshot stop waits for a delivery that is still in flight: the put lands first, then the wipe, then the snapshot", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    const agent = rig.agents.get("alpha")!;
    let release!: () => void;
    agent.holdTokenPut = new Promise<void>((r) => (release = r));
    let heldAtSnapshot: Buffer | undefined = Buffer.from("not read");
    const original = rig.helper.onSnapshot;
    rig.helper.onSnapshot = (id, snap, dir) => {
      heldAtSnapshot = rig.agents.get(id)?.token;
      original(id, snap, dir);
    };
    const delivery = sb.deliverToken(sentinel());
    await new Promise((r) => setTimeout(r, 50)); // the put is on the wire and held
    const stopping = sb.stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(agent.ops.includes("token_wipe")).toBe(false); // not while the put is pending
    expect(verbs(rig)).not.toContain("snapshot");
    release();
    await delivery;
    await stopping;
    expect(agent.ops.filter((o) => o === "token_put" || o === "token_wipe")).toEqual(["token_put", "token_wipe"]);
    expect(heldAtSnapshot).toBeUndefined();
    expect(verbs(rig)).toEqual(["prepare", "start", "snapshot"]);
  });

  it("a delivery that comes after a stop has begun is refused, and its buffer zeroed", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    const stopping = sb.stop(); // not awaited: the state is still `running` while the snapshot is admitted
    const token = sentinel();
    await expect(sb.deliverToken(token)).rejects.toMatchObject({ status: 409, code: "not_running" });
    expect(zeroed(token)).toBe(true);
    await stopping;
    expect(rig.agents.get("alpha")?.ops.includes("token_put") ?? false).toBe(false);
  });

  it("a delivery still pending after the bound means no snapshot: the VM is destroyed and the error is one fixed code", async () => {
    const rig = makeRig({ extra: { startWaitMs: 150 } });
    const sb = await rig.daemon.create(persistent("alpha"));
    const agent = rig.agents.get("alpha")!;
    let release!: () => void;
    agent.holdTokenPut = new Promise<void>((r) => (release = r));
    const delivery = sb.deliverToken(sentinel()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await expect(sb.stop()).rejects.toMatchObject({ status: 502, code: "token_wipe_failed" });
    expect(verbs(rig)).toEqual(["prepare", "start", "destroy"]);
    release();
    await delivery;
  });

  it("a stop that is not a snapshot destroys the VM and asks for no wipe: its memory goes with it", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create({ name: "alpha", template: "fx-agent", vcpus: 1, memMb: 256 });
    const agent = rig.agents.get("alpha")!;
    await sb.deliverToken(sentinel());
    await sb.stop();
    expect(agent.ops.includes("token_wipe")).toBe(false);
    expect(verbs(rig)).toEqual(["prepare", "start", "destroy"]);
  });
});
