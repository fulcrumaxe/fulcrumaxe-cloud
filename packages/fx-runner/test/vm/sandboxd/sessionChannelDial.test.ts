import { mkdirSync } from "node:fs";
import path from "node:path";
import { duplexPair } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL_PORT } from "../../../src/engineHost/guestSession.js";
import { createMicrovmVmPort } from "../../../src/vm/sandboxd/vmPort.js";
import { productionDepsBase } from "../../../src/vm/sandboxd/production.js";
import { productionSnapshots } from "../../../src/vm/sandboxd/snapshots.js";
import { makeRig, runCleanups, scratch } from "./helpers.js";

afterEach(runCleanups);
const params = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512 });

/** D#845 ON-13b2: the runner's dial of the engine session's channel (vsock port 5255) and the production snapshot wiring (Ruling 81.1a). */
describe("the daemon's connect", () => {
  it("dials the running VM's checked vsock directory at the port asked for, and for nothing else", async () => {
    const dialed: Array<{ dir: string; port: number }> = [];
    const [client, server] = duplexPair();
    const rig = makeRig({ extra: { dial: async (dir, port) => (dialed.push({ dir, port }), client) } });
    await rig.daemon.create(params("alpha"));
    expect(await rig.daemon.connect("alpha", CHANNEL_PORT)).toBe(client);
    expect(dialed).toHaveLength(1);
    expect(path.basename(dialed[0]?.dir ?? "")).toBe("alpha"); // the directory the helper named and the daemon checked, whose last part is the sandbox's id
    expect(dialed[0]?.port).toBe(5255);
    expect(CHANNEL_PORT).toBe(5255);
    server.destroy();
  });

  it("refuses a sandbox that is not running, an unknown one, and a daemon built with no dial", async () => {
    const rig = makeRig({ extra: { dial: async () => Promise.reject(new Error("must not be dialed")) } });
    await rig.daemon.create(params("alpha"));
    await rig.daemon.stop("alpha").catch(() => undefined); // fx-swallow-ok: this build keeps no snapshot for a non-persistent sandbox; either way it is no longer running
    await expect(rig.daemon.connect("alpha", 5255)).rejects.toMatchObject({ status: 409 });
    await expect(rig.daemon.connect("nope", 5255)).rejects.toMatchObject({ status: 404 });
    const plain = makeRig();
    await plain.daemon.create(params("beta"));
    await expect(plain.daemon.connect("beta", 5255)).rejects.toMatchObject({ code: "not_running" });
  });

  it("the production dial goes through the checked descriptors: a host that has none (no euid) is refused with one fixed word", async () => {
    const deps = productionDepsBase({ helperSocket: "/nonexistent/fx-helper.sock", host: { euid: undefined, platform: process.platform } });
    await expect(deps.dial?.("/fictional/vsock/alpha", 5255)).rejects.toMatchObject({ code: "unreachable" });
  });
});

describe("the VM port's channel", () => {
  it("is the daemon's connect to port 5255 of the sandbox by its daemon id", async () => {
    const dialed: Array<{ id: string; port: number }> = [];
    const [client, server] = duplexPair();
    const port = createMicrovmVmPort({
      sandbox: { createSandbox: async () => ({ runId: "", sandboxName: "n", sessionId: "" }), stop: async () => undefined, deleteSandbox: async () => undefined, guestOf: async () => ({}) as never, sandboxState: async () => "running" as never },
      daemon: { teardown: async () => true, get: async (id: string) => ({ connect: async (p: number) => (dialed.push({ id, port: p }), client) }) as never },
      bindings: { bind: () => ({}) as never, unbind: () => undefined },
      policy: { release: async () => undefined },
      idOf: (name) => `id-${name}`,
      timeoutMs: 1,
    });
    expect(await port.channel?.("fx-engine-77")).toBe(client);
    expect(dialed).toEqual([{ id: "id-fx-engine-77", port: 5255 }]);
    server.destroy();
  });
});

describe("the production snapshot wiring", () => {
  const caps = { snapshotDir: "/fictional/snapshots", snapshotQuotaBytes: 5 * 1024 ** 3 };
  const free = (): number => 1;
  it("is the runner's two snapshot limits, the free-space reader and the daemon's own state directory, made 0700 first", () => {
    const made: Array<{ dir: string; uid: number }> = [];
    const state = path.join(scratch(), "sandboxd");
    const deps = productionSnapshots({ sandboxdDir: state, uid: 1000, caps, freeBytes: free, ensureDir: (dir, uid) => void made.push({ dir, uid }) });
    expect(deps).toEqual({ dir: caps.snapshotDir, quotaBytes: caps.snapshotQuotaBytes, freeBytes: free, stateDir: state });
    expect(made).toEqual([{ dir: state, uid: 1000 }]);
  });

  it("is nothing (so no sandbox may be persistent and a session's stop fails closed) when a limit is not set, there is no user id, or the directory is not safe", () => {
    const ok = (): void => undefined;
    expect(productionSnapshots({ sandboxdDir: "/x", uid: 1000, caps: undefined, freeBytes: free, ensureDir: ok })).toBeUndefined();
    expect(productionSnapshots({ sandboxdDir: "/x", uid: undefined, caps, freeBytes: free, ensureDir: ok })).toBeUndefined();
    expect(productionSnapshots({ sandboxdDir: "/x", uid: 1000, caps, freeBytes: free, ensureDir: () => { throw new Error("open to others"); } })).toBeUndefined();
  });

  it("a daemon built with it holds a persistent sandbox's snapshot at stop; one built without refuses to make a sandbox persistent", async () => {
    const dir = path.join(scratch(), "sandboxd");
    mkdirSync(dir, { mode: 0o700 });
    const rig = makeRig({ extra: { snapshots: productionSnapshots({ sandboxdDir: dir, uid: process.getuid?.() ?? 1000, caps: { snapshotDir: "/fictional/snapshots", snapshotQuotaBytes: 1024 ** 3 }, freeBytes: () => 1024 ** 4, ensureDir: () => undefined }) as never } });
    await rig.daemon.create({ ...params("keeper"), retention: { persistent: true } });
    await rig.daemon.stop("keeper");
    expect(rig.helper.frames.map((f) => f["verb"])).toContain("snapshot");
    const bare = makeRig({ extra: { snapshots: undefined } });
    await expect(bare.daemon.create({ ...params("keeper"), retention: { persistent: true } })).rejects.toMatchObject({ code: "bad_request" });
  });
});
