import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EngineStateError, writeJsonAtomic } from "../../../src/engineBridge/stateFiles.js";
import { MIB } from "../../../src/vm/sandboxd/snapshots.js";
import { makeRig, runCleanups, scratch } from "./helpers.js";

afterEach(runCleanups);
const NEED = 512 * MIB + 4 * MIB;
const persistent = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512, retention: { persistent: true } });
const snapshotsOf = (rig: ReturnType<typeof makeRig>): string[] => [...rig.helper.snapshots.keys()];
const stateFile = (rig: ReturnType<typeof makeRig>): string => path.join(rig.deps.snapshots!.stateDir, "sandboxd-snapshots.json");
const orphansOnDisk = (rig: ReturnType<typeof makeRig>): Array<{ id: string; bytes: number }> => JSON.parse(readFileSync(stateFile(rig), "utf8")).orphans;

describe("two stops at once share one quota", () => {
  it("a quota that holds one 512 MiB snapshot admits exactly one of two simultaneous stops", async () => {
    const rig = makeRig({ extra: { snapshots: { dir: "/fictional/snapshots", quotaBytes: 600 * MIB, freeBytes: () => 1024 ** 4, stateDir: path.join(scratch(), "state") } } });
    const [a, b] = [await rig.daemon.create(persistent("one")), await rig.daemon.create(persistent("two"))];
    const results = await Promise.allSettled([a.stop(), b.stop()]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 507, code: "snapshot_refused" });
    expect(snapshotsOf(rig)).toHaveLength(1); // not 1 GiB on a 600 MiB quota
  });

  it("a stop that fails after admission gives its bytes back: the next stop is admitted", async () => {
    const rig = makeRig({ extra: { snapshots: { dir: "/fictional/snapshots", quotaBytes: NEED, freeBytes: () => 1024 ** 4, stateDir: path.join(scratch(), "state") } } });
    const sb = await rig.daemon.create(persistent("one"));
    const other = await rig.daemon.create(persistent("two"));
    await sb.stop(); // makes the state directory exist, and uses the whole quota
    await rig.daemon.delete("one"); // frees it again
    chmodSync(rig.deps.snapshots!.stateDir, 0o500); // the state file cannot be written: the stop fails after it was admitted
    await expect(other.stop()).rejects.toThrow();
    expect(other.status).toBe("running");
    chmodSync(rig.deps.snapshots!.stateDir, 0o700);
    await other.stop(); // the failed one left neither a reservation nor an orphan behind
    expect(snapshotsOf(rig)).toHaveLength(1);
  });
});

describe("a snapshot the helper wrote but the daemon never heard about", () => {
  it("a lost reply leaves an orphan on disk and in the quota, and the next sweep deletes the snapshot", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    rig.helper.dropReply.add("snapshot");
    await expect(sb.stop()).rejects.toMatchObject({ status: 502, code: "helper_failed" });
    expect(snapshotsOf(rig)).toHaveLength(1); // the helper did write it
    expect(orphansOnDisk(rig)).toEqual([{ id: snapshotsOf(rig)[0], bytes: NEED, takenAt: expect.any(Number) }]);
    rig.helper.dropReply.clear();
    await rig.daemon.sweep();
    expect(snapshotsOf(rig)).toEqual([]);
    expect(orphansOnDisk(rig)).toEqual([]);
  });

  it("the trace is written before the helper is asked, so a crash mid-snapshot is cleaned up by the next daemon", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    let release: () => void = () => undefined;
    rig.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    const stopping = sb.stop().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(orphansOnDisk(rig)).toHaveLength(1); // on disk while the helper has not answered
    const restarted = rig.restart(); // the process died here
    release();
    await stopping;
    await restarted.sweep(); // the new daemon finds it as an orphan: it is deleted, never leaked
    expect(snapshotsOf(rig)).toEqual([]);
  });

  it("a sweep during a snapshot that is still being written does not delete it", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    let release: () => void = () => undefined;
    rig.helper.holdSnapshot = new Promise<void>((r) => (release = r));
    const stopping = sb.stop();
    await new Promise((r) => setTimeout(r, 100));
    await rig.daemon.sweep();
    release();
    await stopping;
    expect(rig.helper.frames.filter((f) => f["verb"] === "snapshot_delete")).toEqual([]);
    expect(snapshotsOf(rig)).toHaveLength(1);
    expect(orphansOnDisk(rig)).toEqual([]);
    expect((await rig.daemon.get("alpha", { resume: true })).status).toBe("running"); // the snapshot is a record, so it resumes
  });
});

describe("two resumes at once", () => {
  it("run one resume: the second waits for it and the live v.sock is not touched", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(persistent("alpha"));
    await sb.writeFiles([{ path: "/tmp/f", content: Buffer.from("x") }]);
    await sb.stop();
    const [x, y] = await Promise.all([rig.daemon.get("alpha", { resume: true }), rig.daemon.get("alpha", { resume: true })]);
    expect(rig.helper.frames.filter((f) => f["verb"] === "resume")).toHaveLength(1);
    expect(rig.helper.frames.filter((f) => f["verb"] === "destroy")).toEqual([]); // the first VM was not destroyed
    expect([x.status, y.status]).toEqual(["running", "running"]);
    const chunks: Buffer[] = [];
    await x.readFile("/tmp/f", (c) => void chunks.push(c));
    expect(Buffer.concat(chunks).toString()).toBe("x");
  });

  it("both callers see the same refusal when the one resume fails", async () => {
    const rig = makeRig();
    await (await rig.daemon.create(persistent("alpha"))).stop();
    rig.helper.refuse.set("resume", "snapshot_mismatch");
    const results = await Promise.allSettled([rig.daemon.get("alpha", { resume: true }), rig.daemon.get("alpha", { resume: true })]);
    expect(results.map((r) => (r as PromiseRejectedResult).reason)).toEqual([expect.objectContaining({ code: "snapshot_mismatch" }), expect.objectContaining({ code: "snapshot_mismatch" })]);
    expect(rig.helper.frames.filter((f) => f["verb"] === "resume")).toHaveLength(1);
  });
});

describe("limits that guard the files and the count", () => {
  it("the state-file helper's own write limit stays 16 KiB unless a caller raises it", () => {
    const dir = path.join(scratch(), "state");
    const uid = process.geteuid?.() ?? 0;
    writeJsonAtomic(dir, "small.json", { pad: "x".repeat(15 * 1024) }, uid);
    expect(() => writeJsonAtomic(dir, "big.json", { pad: "x".repeat(17 * 1024) }, uid)).toThrow(EngineStateError);
    writeJsonAtomic(dir, "big.json", { pad: "x".repeat(17 * 1024) }, uid, { maxBytes: 64 * 1024 });
  });

  it("a state file that names more than ten kept snapshots is refused at start", () => {
    const rig = makeRig();
    writeJsonAtomic(rig.deps.snapshots!.stateDir, "sandboxd-snapshots.json", { version: 1, orphans: [], sandboxes: [{ name: "alpha", template: "fx-agent", vcpus: 1, memMb: 256, createdAt: 1, keepLast: 11, snapshots: [] }] }, process.geteuid?.() ?? 0, { maxBytes: 1024 });
    expect(() => rig.restart()).toThrow(/not valid/);
    writeFileSync(stateFile(rig), JSON.stringify({ version: 1, orphans: [], sandboxes: [{ name: "alpha", template: "fx-agent", vcpus: 1, memMb: 256, createdAt: 1, keepLast: 10, snapshots: [] }] }), { mode: 0o600 });
    expect(rig.restart().list()).toHaveLength(1);
  });
});
