import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { TufClient } from "../../src/update/tuf.js";
import type { TufBuildConfig } from "../../src/update/buildConfig.js";
import { Updater } from "../../src/update/updater.js";
import { linkedVersion, loadUpdateState, switchLink, versionBinary } from "../../src/update/versions.js";
import { buildRepo, makeKeys, inHours } from "../fixtures/tufRepo.js";
import { startTufServer, type TufServer } from "../fixtures/tufServer.js";
import { program, realRun, updateWorld } from "../helpers/updateWorld.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe("the stable link is switched by a real rename on the real filesystem", () => {
  it("a reader that polls the link while it is switched back and forth 3000 times never finds it missing or half-made", async () => {
    const w = updateWorld({ installed: ["1.0.0", "1.1.0"], current: "1.0.0" });
    const link = path.join(w.stateDir, "bin", "fx-runner");
    const flag = new Int32Array(new SharedArrayBuffer(20));
    const reader = new Worker(
      `const { workerData } = require("node:worker_threads");
       const fs = require("node:fs");
       const flag = new Int32Array(workerData.flag);
       let bad = 0, reads = 0;
       Atomics.store(flag, 2, 1); Atomics.notify(flag, 2);
       while (Atomics.load(flag, 0) === 0) {
         if (Atomics.load(flag, 3) === 1) Atomics.add(flag, 4, 1);
         try { const t = fs.readlinkSync(workerData.link); if (t !== "../versions/1.0.0/fx-runner" && t !== "../versions/1.1.0/fx-runner") bad++; } catch { bad++; }
         reads++;
       }
       Atomics.store(flag, 1, bad); Atomics.store(flag, 0, 2);
       require("node:worker_threads").parentPort.postMessage({ bad, reads });`,
      { eval: true, workerData: { link, flag: flag.buffer } },
    );
    const done = new Promise<{ bad: number; reads: number }>((resolve, reject) => {
      reader.on("message", resolve);
      reader.on("error", reject);
    });
    // slot 2: the reader is running (it signals before its first read); slot 3: switching is in progress; slot 4: reads taken while it was.
    expect(Atomics.wait(flag, 2, 0, 20_000)).not.toBe("timed-out");
    Atomics.store(flag, 3, 1);
    let switches = 0;
    // At least 3000 switches, and on until the reader has taken enough reads DURING them (capped), so a slow worker cannot make this vacuous.
    while (switches < 3000 || (Atomics.load(flag, 4) < 50 && switches < 300_000)) switchLink(w.stateDir, switches++ % 2 === 0 ? "1.1.0" : "1.0.0");
    if (switches % 2 === 1) switchLink(w.stateDir, "1.0.0");
    Atomics.store(flag, 3, 0);
    Atomics.store(flag, 0, 1);
    const result = await done;
    expect(Atomics.load(flag, 4)).toBeGreaterThanOrEqual(50);
    expect(result.reads).toBeGreaterThan(0);
    expect(result.bad).toBe(0);
    expect(linkedVersion(w.stateDir)).toBe("1.0.0");
  });

  it("leaves no temporary link behind", () => {
    const w = updateWorld({ installed: ["1.0.0", "1.1.0"] });
    switchLink(w.stateDir, "1.1.0");
    expect(readlinkSync(path.join(w.stateDir, "bin", "fx-runner"))).toBe("../versions/1.1.0/fx-runner");
    expect(readdirSync(path.join(w.stateDir, "bin"))).toEqual(["fx-runner"]);
  });
});

describe("the real release client end to end (test keys, a local TLS server)", () => {
  const TARGET = "v1.1.0/fx-runner-linux-x64";

  async function rig(content: Buffer, tamper?: (server: TufServer) => void) {
    const keys = makeKeys();
    const repo = buildRepo({ root: { version: 1, keys }, targets: [{ path: TARGET, content }, { path: "v1.0.5/fx-runner-linux-x64", content: program("1.0.5") }, { path: "v2.0.0/fx-runner-darwin-arm64", content: Buffer.from("x") }], expires: { timestamp: inHours(24), snapshot: inHours(24), targets: inHours(24) } });
    const server = await startTufServer(repo);
    tamper?.(server);
    const world = updateWorld();
    cleanups.push(() => server.close());
    const build: TufBuildConfig = { root: repo.rootText, metadataBaseUrl: server.metadataBase, targetBaseUrl: server.targetBase };
    const tuf = new TufClient({ stateDir: world.stateDir, build, ca: server.ca });
    const updater = new Updater({ stateDir: world.stateDir, host: world.host, now: () => new Date(), tuf });
    return { world, server, updater, tuf };
  }

  it("lists the signed versions for this platform, downloads the newest, verifies, starts it and switches", async () => {
    const next = program("1.1.0");
    const r = await rig(next);
    const checked = await r.updater.check();
    expect(checked).toMatchObject({ ok: true, available: "1.1.0" });
    const result = await r.updater.applyLatest();
    expect(result).toMatchObject({ ok: true, version: "1.1.0" });
    expect(readFileSync(versionBinary(r.world.stateDir, "1.1.0")).equals(next)).toBe(true);
    const started = await realRun(path.join(r.world.stateDir, "bin", "fx-runner"), ["--version"], 5000);
    expect(started.stdout).toContain("fx-runner 1.1.0");
    expect(loadUpdateState(r.world.stateDir).previous).toBe("1.0.0");
  });

  it("a release file changed on the server after signing is refused and the link does not move", async () => {
    const r = await rig(program("1.1.0"), (server) => {
      server.files.set(TARGET, program("6.6.6"));
    });
    const result = await r.updater.applyLatest();
    expect(result).toMatchObject({ ok: false });
    expect(linkedVersion(r.world.stateDir)).toBe("1.0.0");
    expect(readFileSync(path.join(r.world.stateDir, "versions", "1.0.0", "fx-runner")).length).toBeGreaterThan(0);
  });

  it("nothing is fetched and no tuf folder is written in a build with no root", async () => {
    const world = updateWorld();
    const tuf = new TufClient({ stateDir: world.stateDir, build: { root: undefined, metadataBaseUrl: undefined, targetBaseUrl: undefined } });
    const updater = new Updater({ stateDir: world.stateDir, host: world.host, now: () => new Date(), tuf });
    expect(await updater.check()).toMatchObject({ ok: false, state: "not_configured" });
    expect(await updater.applyLatest()).toMatchObject({ ok: false, code: "not_configured" });
    expect(await updater.install("1.1.0", true)).toMatchObject({ ok: false, code: "not_configured" });
    expect(existsSync(path.join(world.stateDir, "tuf"))).toBe(false);
  });
});
