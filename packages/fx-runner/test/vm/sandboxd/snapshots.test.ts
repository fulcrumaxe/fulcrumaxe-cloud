import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperError } from "../../../src/vm/sandboxd/helperClient.js";
import { MIB, admitSnapshot } from "../../../src/vm/sandboxd/snapshots.js";
import { VsockRefused, removeOwnVsockSocket, type FdOps } from "../../../src/vm/sandboxd/vsockFd.js";
import { makeRig, realOps, runCleanups, scratch } from "./helpers.js";

afterEach(runCleanups);
const NEED = 512 * MIB + 4 * MIB; // a 512 MiB guest's snapshot: its RAM and the device-state file
const persistent = (name: string, keep?: number) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512, retention: { persistent: true, ...(keep === undefined ? {} : { keepLastSnapshots: keep }) } });
const verbs = (rig: ReturnType<typeof makeRig>): unknown[] => rig.helper.frames.map((f) => f["verb"]);
const stateFile = (rig: ReturnType<typeof makeRig>): string => path.join(rig.deps.snapshots!.stateDir, "sandboxd-snapshots.json");
const readBack = async (sb: { readFile(p: string, s: (c: Buffer) => void): Promise<number> }, p: string): Promise<string> => {
  const chunks: Buffer[] = [];
  await sb.readFile(p, (c) => void chunks.push(c));
  return Buffer.concat(chunks).toString();
};

describe("stop writes a snapshot and resume restores it", () => {
  it("a file written before the stop is read back after the resume, and the stale v.sock was removed first", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    await sb.writeFiles([{ path: "/tmp/note", content: Buffer.from("before the stop") }]);
    await sb.stop();
    expect(sb.status).toBe("stopped");
    expect(verbs(rig)).toEqual(["prepare", "start", "snapshot"]); // no destroy: the sandbox stays prepared for the resume
    expect(rig.helper.frames[2]).toEqual({ verb: "snapshot", sandbox_id: "alpha", snapshot_id: expect.stringMatching(/^sn[0-9a-f]{24}$/) });
    expect(existsSync(path.join(rig.helper.entries.get("alpha")!.dir, "v.sock"))).toBe(true); // the dead VM left it behind
    await expect(sb.runCommand({ cmd: "true" })).rejects.toMatchObject({ status: 409, code: "not_running" });
    await rig.daemon.get("alpha", { resume: true });
    expect(sb.status).toBe("running");
    expect(verbs(rig).slice(3)).toEqual(["list", "resume"]);
    expect(rig.helper.frames[4]).toEqual({ verb: "resume", sandbox_id: "alpha", snapshot_id: rig.helper.frames[2]!["snapshot_id"] });
    expect(await readBack(sb, "/tmp/note")).toBe("before the stop");
  });

  it("a sandbox that is not persistent is destroyed by stop and boots fresh, as before", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create({ name: "plain", template: "fx-agent", vcpus: 1, memMb: 256 });
    await sb.stop();
    expect(verbs(rig)).toEqual(["prepare", "start", "destroy"]);
    expect(existsSync(stateFile(rig))).toBe(false);
  });

  it("a persistent create with nowhere to keep snapshots is refused, and so is a bad keepLastSnapshots", async () => {
    const rig = makeRig({ extra: { snapshots: undefined } });
    await expect(rig.daemon.create(persistent("alpha"))).rejects.toMatchObject({ status: 400, code: "bad_request" });
    const other = makeRig();
    for (const keep of [0, -1, 1.5, 11, 1000]) await expect(other.daemon.create(persistent("beta", keep))).rejects.toMatchObject({ code: "bad_request" });
    expect(other.helper.frames).toEqual([]);
    await other.daemon.create(persistent("gamma", 10)); // the bound itself is allowed
  });

  it("a snapshot the helper fails to write leaves the sandbox stopped with nothing to resume, and the VM destroyed", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    rig.helper.refuse.set("snapshot", "internal");
    await expect(sb.stop()).rejects.toMatchObject({ status: 502, code: "helper_failed" });
    expect(verbs(rig)).toEqual(["prepare", "start", "snapshot", "destroy"]);
    expect(sb.status).toBe("stopped");
    await expect(rig.daemon.get("alpha", { resume: true })).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("a snapshot that takes longer than the helper's ordinary timeout", () => {
  it("a stop waits for it: the VM is not destroyed in the middle of the write, and the snapshot is kept", async () => {
    // the ordinary request timeout is 150 ms here (30 s in production); the write takes 600 ms (39 to 41 s on the real VM)
    const rig2 = makeRig({ helperMs: { request: 150 } });
    const sb = await rig2.daemon.create(persistent("alpha"));
    let release!: () => void;
    rig2.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    setTimeout(() => release(), 600);
    await sb.stop();
    expect(sb.status).toBe("stopped");
    expect(verbs(rig2)).toEqual(["prepare", "start", "snapshot"]); // never a destroy
    await rig2.daemon.get("alpha", { resume: true });
    expect(sb.status).toBe("running");
  });

  it("a write that outlasts even the snapshot bound is reported with the closed code, and the VM is left to the helper: no destroy, no resume", async () => {
    const rig2 = makeRig({ helperMs: { request: 5000, snapshot: 150 } });
    const sb = await rig2.daemon.create(persistent("alpha"));
    let release!: () => void;
    rig2.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    await expect(sb.stop()).rejects.toMatchObject({ status: 502, code: "helper_failed" });
    expect(verbs(rig2)).toEqual(["prepare", "start", "snapshot"]); // the destroy would have cut the write short
    expect(sb.status).toBe("running");
    release();
  });

  /** A stop whose snapshot reply timed out while the helper went on writing; resolves once the helper holds the file. */
  async function timedOut(): Promise<ReturnType<typeof makeRig>> {
    const rig2 = makeRig({ helperMs: { request: 5000, snapshot: 150 } });
    const sb = await rig2.daemon.create(persistent("alpha"));
    let release!: () => void;
    rig2.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    await expect(sb.stop()).rejects.toMatchObject({ code: "helper_failed" });
    release();
    for (let i = 0; i < 100 && rig2.helper.snapshots.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rig2.helper.snapshots.size).toBe(1); // the write finished behind the daemon's back
    return rig2;
  }

  it("while the helper may still be writing, a sweep does not delete the snapshot: the file would be pulled from under the write", async () => {
    const rig2 = makeRig({ helperMs: { request: 5000, snapshot: 150 } });
    const sb = await rig2.daemon.create(persistent("alpha"));
    let release!: () => void;
    rig2.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    await expect(sb.stop()).rejects.toMatchObject({ code: "helper_failed" });
    await rig2.daemon.sweep();
    expect(verbs(rig2)).not.toContain("snapshot_delete");
    release();
  });

  it("hasTimedOutWrite is false on a fresh running record, true after a snapshot timeout, and false again once a destroy has returned", async () => {
    const rig2 = makeRig({ helperMs: { request: 5000, snapshot: 150 } });
    const sb = await rig2.daemon.create(persistent("alpha"));
    expect(rig2.daemon.hasTimedOutWrite("alpha")).toBe(false);
    expect(rig2.daemon.hasTimedOutWrite("nobody")).toBe(false);
    let release!: () => void;
    rig2.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    await expect(sb.stop()).rejects.toMatchObject({ code: "helper_failed" });
    expect(rig2.daemon.hasTimedOutWrite("alpha")).toBe(true);
    release();
    for (let i = 0; i < 100 && rig2.helper.snapshots.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await sb.stop();
    expect(rig2.daemon.hasTimedOutWrite("alpha")).toBe(false);
  });

  it("a destroy that times out while the write is still held releases nothing: no sweep deletes the file, the id stays on the orphan list, and a later stop does", async () => {
    const rig2 = makeRig({ helperMs: { request: 150, snapshot: 150 } });
    const sb = await rig2.daemon.create(persistent("alpha"));
    let release!: () => void;
    rig2.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    await expect(sb.stop()).rejects.toMatchObject({ code: "helper_failed" }); // the snapshot reply timed out
    await expect(sb.stop()).rejects.toMatchObject({ code: "helper_failed" }); // the destroy waits for the write (as the real helper's does) and times out too
    await rig2.daemon.sweep();
    expect(verbs(rig2)).not.toContain("snapshot_delete");
    expect(JSON.parse(readFileSync(stateFile(rig2), "utf8")).orphans).toHaveLength(1);
    release();
    for (let i = 0; i < 100 && rig2.helper.snapshots.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rig2.helper.snapshots.size).toBe(1);
    await sb.stop(); // the write is over: the destroy answers, the id is released
    await rig2.daemon.sweep();
    expect(rig2.helper.snapshots.size).toBe(0);
    expect(JSON.parse(readFileSync(stateFile(rig2), "utf8")).orphans).toEqual([]);
  });

  it("a destroy the helper answers with unknown_sandbox releases the id too: nothing is writing for a sandbox it does not hold", async () => {
    const rig2 = await timedOut();
    rig2.helper.entries.delete("alpha"); // a helper restart lost its registry; the snapshot file stays
    await rig2.daemon.stop("alpha");
    await rig2.daemon.sweep();
    expect(rig2.helper.snapshots.size).toBe(0);
  });

  it("a delete after the timeout removes the written snapshot: a snapshot_delete is sent and the helper's store and the state file end empty", async () => {
    const rig2 = await timedOut();
    const id = String(rig2.helper.frames.find((f) => f["verb"] === "snapshot")!["snapshot_id"]);
    await rig2.daemon.delete("alpha");
    expect(rig2.helper.frames).toContainEqual({ verb: "snapshot_delete", snapshot_id: id });
    expect(rig2.helper.snapshots.size).toBe(0);
    expect(JSON.parse(readFileSync(stateFile(rig2), "utf8"))).toEqual({ version: 1, sandboxes: [], orphans: [] });
  });

  it("after the timeout and a daemon restart, the sweep deletes the snapshot: its id stayed on the orphan list", async () => {
    const rig2 = await timedOut();
    expect(JSON.parse(readFileSync(stateFile(rig2), "utf8")).orphans).toHaveLength(1);
    await rig2.restart().sweep();
    expect(rig2.helper.snapshots.size).toBe(0);
  });

  it("the next stop of that sandbox is a destroy with no second snapshot, so a person's Stop ends it and the snapshot is released for the sweep", async () => {
    const rig2 = await timedOut();
    const sb = await rig2.daemon.get("alpha");
    await sb.stop();
    expect(sb.status).toBe("stopped");
    expect(verbs(rig2)).toEqual(["prepare", "start", "snapshot", "destroy"]);
    await rig2.daemon.sweep();
    expect(rig2.helper.snapshots.size).toBe(0);
  });
});

describe("admission", () => {
  it("refuses when the free bytes are below the guest's RAM, names both numbers, and leaves the sandbox running", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    rig.free.bytes = NEED - 1;
    const err = await sb.stop().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 507, code: "snapshot_refused" });
    expect(String((err as Error).message)).toContain(`${NEED - 1} bytes free`);
    expect(String((err as Error).message)).toContain(`needs ${NEED} bytes`);
    expect(sb.status).toBe("running");
    expect(verbs(rig)).toEqual(["prepare", "start"]);
    rig.free.bytes = NEED; // exactly the RAM and the state file is enough
    await sb.stop();
    expect(sb.status).toBe("stopped");
  });

  it("refuses when the quota would be exceeded, counting the snapshots already held, and names the numbers", async () => {
    const rig = makeRig({ extra: { snapshots: { dir: "/fictional/snapshots", quotaBytes: NEED + 99, freeBytes: () => 1024 ** 4, stateDir: path.join(scratch(), "state") } } });
    rig.helper.snapshotBytes = 100;
    const one = await rig.daemon.create(persistent("one"));
    await one.stop(); // 100 bytes held
    const two = await rig.daemon.create(persistent("two"));
    const err = await two.stop().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 507, code: "snapshot_refused" });
    expect(String((err as Error).message)).toContain(`100 bytes held plus ${NEED} for this snapshot`);
    expect(two.status).toBe("running");
  });

  it("refuses when the free space cannot be read, and the pure rule's boundaries hold", () => {
    const need = 10 + 4 * MIB; // the RAM and the device-state file
    expect(admitSnapshot({ guestRamBytes: 10, usedBytes: 0, quotaBytes: need, freeBytes: undefined })).toMatchObject({ admit: false });
    expect(admitSnapshot({ guestRamBytes: 10, usedBytes: 0, quotaBytes: need, freeBytes: need })).toEqual({ admit: true });
    expect(admitSnapshot({ guestRamBytes: 10, usedBytes: 1, quotaBytes: need, freeBytes: need * 2 })).toMatchObject({ admit: false });
    expect(admitSnapshot({ guestRamBytes: 10, usedBytes: 0, quotaBytes: need, freeBytes: need - 1 })).toMatchObject({ admit: false });
    expect(admitSnapshot({ guestRamBytes: 10, usedBytes: 0, quotaBytes: 10, freeBytes: need * 2 })).toMatchObject({ admit: false }); // a quota of the RAM alone is not enough
  });
});

describe("keepLastSnapshots and expiry", () => {
  const cycle = async (rig: ReturnType<typeof makeRig>, name: string): Promise<void> => {
    await (await rig.daemon.get(name, { resume: true })).stop();
    rig.clock.t += 10;
  };

  it("keepLastSnapshots 1: the second stop writes its snapshot first, then evicts the first; the newest is the one resumed", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    await sb.stop();
    const first = rig.helper.frames[2]!["snapshot_id"];
    await cycle(rig, "alpha");
    const order = verbs(rig).filter((v) => v === "snapshot" || v === "snapshot_delete");
    expect(order).toEqual(["snapshot", "snapshot", "snapshot_delete"]);
    expect(rig.helper.frames.at(-1)).toEqual({ verb: "snapshot_delete", snapshot_id: first });
    expect(rig.helper.snapshots.size).toBe(1);
    await rig.daemon.get("alpha", { resume: true });
    expect(rig.helper.frames.at(-1)).toMatchObject({ verb: "resume", snapshot_id: [...rig.helper.snapshots.keys()][0] });
  });

  it("keepLastSnapshots 2 keeps two and evicts the oldest on the third", async () => {
    const rig = makeRig();
    await (await rig.daemon.create(persistent("alpha", 2))).stop();
    await cycle(rig, "alpha");
    expect(rig.helper.snapshots.size).toBe(2);
    await cycle(rig, "alpha");
    expect(rig.helper.snapshots.size).toBe(2);
    expect(verbs(rig).filter((v) => v === "snapshot_delete")).toHaveLength(1);
  });

  it("an expired snapshot is evicted and the next resume is not_found; delete then lets the fallback start fresh under the same name", async () => {
    const rig = makeRig({ extra: { snapshots: { dir: "/fictional/snapshots", quotaBytes: 1024 ** 3, freeBytes: () => 1024 ** 4, stateDir: path.join(scratch(), "state"), ttlSeconds: 100 } } });
    const sb = await rig.daemon.create(persistent("alpha"));
    await sb.stop();
    rig.clock.t += 99;
    await rig.daemon.get("alpha", { resume: true }).then((s) => s.stop()); // still inside the lifetime
    rig.clock.t += 100;
    await expect(rig.daemon.get("alpha", { resume: true })).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(rig.helper.snapshots.size).toBe(0);
    expect(sb.status).toBe("stopped");
    await rig.daemon.delete("alpha");
    expect((await rig.daemon.create(persistent("alpha"))).status).toBe("running");
  });

  it("a snapshot the helper no longer has is forgotten, and the resume is not_found", async () => {
    const rig = makeRig();
    await (await rig.daemon.create(persistent("alpha"))).stop();
    rig.helper.snapshots.clear();
    await expect(rig.daemon.get("alpha", { resume: true })).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(rig.daemon.get("alpha", { resume: true })).rejects.toMatchObject({ status: 404 });
    expect(verbs(rig).filter((v) => v === "resume")).toHaveLength(1); // the second one never reached the helper
  });

  it("a delete the helper does not confirm leaves the snapshot counted against the quota until a later pass confirms it", async () => {
    const rig = makeRig({ extra: { snapshots: { dir: "/fictional/snapshots", quotaBytes: NEED + 150, freeBytes: () => 1024 ** 4, stateDir: path.join(scratch(), "state") } } });
    rig.helper.snapshotBytes = 100;
    const sb = await rig.daemon.create(persistent("alpha"));
    await sb.stop();
    rig.helper.refuse.set("snapshot_delete", "internal");
    await cycle(rig, "alpha"); // the first snapshot is evicted but its delete is refused: 200 bytes are held
    expect(JSON.parse(readFileSync(stateFile(rig), "utf8")).orphans).toHaveLength(1);
    const two = await rig.daemon.create(persistent("two"));
    await expect(two.stop()).rejects.toMatchObject({ code: "snapshot_refused" }); // 200 held (the orphan counts) + 512 MiB is over; without it, 100 + 512 MiB fits
    rig.helper.refuse.clear();
    await cycle(rig, "alpha"); // this pass retries the orphan too
    expect(JSON.parse(readFileSync(stateFile(rig), "utf8")).orphans).toEqual([]);
  });
});

describe("a snapshot is tied to its disk", () => {
  it("snapshot_mismatch is a clear refusal that keeps the snapshot and nothing running", async () => {
    const rig = makeRig();
    await (await rig.daemon.create(persistent("alpha"))).stop();
    rig.helper.refuse.set("resume", "snapshot_mismatch");
    const err = await rig.daemon.get("alpha", { resume: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "snapshot_mismatch" });
    expect(String((err as Error).message)).not.toContain("template");
    expect(rig.daemon.list()).toEqual([{ name: "alpha", state: "stopped", createdAt: 1_700_000_000 }]);
    expect(verbs(rig).at(-1)).toBe("destroy"); // the half-resumed sandbox is cleaned up
    rig.helper.refuse.clear(); // the template was put back
    expect((await rig.daemon.get("alpha", { resume: true })).status).toBe("running");
  });
});

describe("snapshot records persist across a daemon restart", () => {
  it("a new daemon over the same state file resumes the snapshot; the file is 0600 in a 0700 directory", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha", 3));
    await sb.writeFiles([{ path: "/tmp/kept", content: Buffer.from("across a restart") }]);
    await sb.stop();
    expect(statSync(stateFile(rig)).mode & 0o777).toBe(0o600);
    expect(statSync(rig.deps.snapshots!.stateDir).mode & 0o777).toBe(0o700);
    const again = rig.restart();
    expect(again.list()).toEqual([{ name: "alpha", state: "stopped", createdAt: 1_700_000_000 }]);
    expect(again.registered.has("alpha")).toBe(true);
    expect(await readBack(await again.get("alpha", { resume: true }), "/tmp/kept")).toBe("across a restart");
    expect(rig.helper.frames.at(-1)).toMatchObject({ verb: "resume" });
  });

  it("after a restart the helper may have forgotten the sandbox: it is prepared again before the resume", async () => {
    const rig = makeRig();
    await (await rig.daemon.create(persistent("alpha"))).stop();
    rig.helper.entries.get("alpha")!.running = false;
    const dir = rig.helper.entries.get("alpha")!.dir;
    rig.helper.entries.delete("alpha"); // a helper restart loses its registry; the snapshot files stay
    rig.helper.frames.length = 0;
    rig.helper.entries.set("alpha", { dir }); // prepare of an unknown id makes the entry again
    unlinkSync(path.join(dir, "v.sock"));
    await rig.restart().get("alpha", { resume: true });
    expect(verbs(rig)).toEqual(["list", "resume"]);
  });

  it("an evicted snapshot is gone from the file too, a delete empties it, and a malformed or linked file stops the daemon", async () => {
    const rig = makeRig();
    await (await rig.daemon.create(persistent("alpha"))).stop();
    expect(JSON.parse(readFileSync(stateFile(rig), "utf8")).sandboxes).toHaveLength(1);
    await rig.daemon.delete("alpha");
    expect(rig.helper.snapshots.size).toBe(0);
    expect(JSON.parse(readFileSync(stateFile(rig), "utf8"))).toEqual({ version: 1, sandboxes: [], orphans: [] });
    writeFileSync(stateFile(rig), "{\"version\":1,\"sandboxes\":[{\"name\":\"../x\",\"template\":\"fx-agent\",\"vcpus\":1,\"memMb\":256,\"createdAt\":1,\"keepLast\":1,\"snapshots\":[]}],\"orphans\":[]}\n", { mode: 0o600 });
    expect(() => rig.restart()).toThrow(/not valid/);
    unlinkSync(stateFile(rig));
    const target = path.join(scratch(), "elsewhere.json");
    writeFileSync(target, "{\"version\":1,\"sandboxes\":[],\"orphans\":[]}\n", { mode: 0o600 });
    symlinkSync(target, stateFile(rig));
    expect(() => rig.restart()).toThrow();
    unlinkSync(stateFile(rig));
    writeFileSync(stateFile(rig), "{\"version\":1,\"sandboxes\":[],\"orphans\":[]}\n", { mode: 0o644 });
    chmodSync(stateFile(rig), 0o644);
    expect(() => rig.restart()).toThrow(); // open to others
  });

  it("the teardown destroys the VM without taking a snapshot and keeps the record of a sandbox that holds some", async () => {
    const rig = makeRig();
    await (await rig.daemon.create(persistent("alpha"))).stop();
    await rig.daemon.get("alpha", { resume: true });
    const before = rig.helper.snapshots.size;
    expect(await rig.daemon.teardown("alpha")).toBe(true);
    expect(rig.helper.snapshots.size).toBe(before); // no new snapshot was written for a teardown
    expect(rig.daemon.list()).toHaveLength(1); // its snapshot is what the next daemon resumes from
    await rig.daemon.create(persistent("beta"));
    expect(await rig.daemon.teardown("beta")).toBe(true);
    expect(rig.daemon.list().map((r) => r.name)).toEqual(["alpha"]);
    expect(rig.helper.snapshots.size).toBe(before);
  });
});

describe("removing the runner's own v.sock", () => {
  const listen = (file: string): Promise<net.Server> => new Promise((resolve) => { const s = net.createServer().listen(file, () => resolve(s)); });
  const withOps = (over: Partial<FdOps> = {}): FdOps & { closed: number[]; unlinked: string[] } => {
    const real = realOps();
    const closed: number[] = [];
    const unlinked: string[] = [];
    return { ...real, close: (fd) => (closed.push(fd), real.close(fd)), unlink: (p) => (unlinked.push(p), real.unlink(p)), ...over, closed, unlinked };
  };

  it("removes a socket the runner owns, through the directory's fd, and closes every fd", async () => {
    const dir = scratch();
    const server = await listen(path.join(dir, "v.sock"));
    const ops = withOps();
    removeOwnVsockSocket(dir, ops);
    server.close();
    expect(existsSync(path.join(dir, "v.sock"))).toBe(false);
    expect(ops.unlinked).toHaveLength(1);
    expect(ops.unlinked[0]).toMatch(/^\/proc\/self\/fd\/\d+\/v\.sock$/); // never the path of the sandbox's directory
    expect(ops.closed).toHaveLength(2);
  });

  it("an empty directory is fine; a link, a plain file and another owner's socket are refused and left in place", async () => {
    const dir = scratch();
    const ops = withOps();
    removeOwnVsockSocket(dir, ops);
    const target = path.join(scratch(), "victim");
    writeFileSync(target, "x");
    symlinkSync(target, path.join(dir, "v.sock"));
    expect(() => removeOwnVsockSocket(dir, ops)).toThrow(VsockRefused);
    expect(existsSync(target)).toBe(true);
    unlinkSync(path.join(dir, "v.sock"));
    writeFileSync(path.join(dir, "v.sock"), "not a socket");
    expect(() => removeOwnVsockSocket(dir, ops)).toThrow(VsockRefused);
    unlinkSync(path.join(dir, "v.sock"));
    const server = await listen(path.join(dir, "v.sock"));
    // another owner for the socket only, then for the directory only: each alone must refuse, and nothing is unlinked
    for (const ownerOf of ["socket", "directory"] as const) {
      const foreign = withOps({ fstat: (fd) => { const st = realOps().fstat(fd); const other = st.isDirectory() === (ownerOf === "directory"); return Object.assign(Object.create(st) as object, { uid: other ? st.uid + 1 : st.uid, isSocket: () => st.isSocket(), isDirectory: () => st.isDirectory(), isSymbolicLink: () => st.isSymbolicLink() }) as ReturnType<FdOps["fstat"]>; } });
      expect(() => removeOwnVsockSocket(dir, foreign)).toThrow(VsockRefused);
      expect(foreign.unlinked).toEqual([]);
    }
    server.close();
    expect(ops.unlinked).toEqual([]);
  });

  it("a vsock directory that is a link, or a refusal during a resume, stops the resume before the helper is asked", async () => {
    const rig = makeRig({ extra: { removeVsockSocket: () => { throw new VsockRefused(); } } });
    await (await rig.daemon.create(persistent("alpha"))).stop();
    await expect(rig.daemon.get("alpha", { resume: true })).rejects.toMatchObject({ status: 502, code: "vsock_dir_refused" });
    expect(verbs(rig)).not.toContain("resume");
  });
});

describe("the helper client's snapshot frames", () => {
  it("a snapshot reply without a whole positive snapshot_bytes is a bad reply, and the new refusal codes are known", async () => {
    const rig = makeRig();
    await rig.daemon.create(persistent("alpha"));
    rig.helper.raw.set("snapshot", `${JSON.stringify({ ok: true, protocol: 1, snapshot_bytes: 0 })}\n`);
    await expect(rig.deps.helper.snapshot("alpha", "snx")).rejects.toMatchObject({ code: "bad_reply" });
    rig.helper.raw.clear();
    for (const code of ["unknown_snapshot", "snapshot_mismatch"] as const) {
      rig.helper.refuse.set("resume", code);
      const err = await rig.deps.helper.resume("alpha", "snx").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HelperError);
      expect(err).toMatchObject({ code });
    }
  });
});
