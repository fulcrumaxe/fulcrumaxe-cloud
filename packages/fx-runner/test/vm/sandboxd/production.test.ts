import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../../src/cliError.js";
import { REFUSING_OPS, createProductionSandboxd, productionDeps } from "../../../src/vm/sandboxd/production.js";
import { VsockRefused, dialVsockDir, realFdOps } from "../../../src/vm/sandboxd/vsockFd.js";
import { makeRig, runCleanups, scratch } from "./helpers.js";

afterEach(() => runCleanups());

const params = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512 });
const euid = process.geteuid?.();
const noOps = [
  ["darwin with a non-root euid", { euid, platform: "darwin" }],
  ["win32 with a non-root euid", { euid, platform: "win32" }],
  ["linux with no euid", { euid: undefined, platform: "linux" }],
] as const;

/** A real vsock directory with a real socket in it, owned by this user, that counts every connection it is offered. */
async function listening(): Promise<{ dir: string; connections: () => number; close: () => Promise<void> }> {
  const dir = scratch();
  mkdirSync(dir, { recursive: true });
  let count = 0;
  const server = net.createServer((c) => {
    count += 1;
    c.destroy();
  });
  await new Promise<void>((resolve) => server.listen(path.join(dir, "v.sock"), resolve));
  return { dir, connections: () => count, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("production wiring where there are no descriptor operations", () => {
  it("the test host really has a non-root euid and a real socket to offer", () => {
    expect(typeof euid).toBe("number");
    expect(euid).toBeGreaterThan(0);
  });

  describe.each(noOps)("%s", (_name, host) => {
    it("inspection finds nothing, even for a directory that is there and ours", () => {
      const deps = productionDeps({ host, helperSocket: "/nonexistent/helper.sock", boot: makeRig().deps.boot });
      expect(deps.inspectDir(scratch())).toBeUndefined();
    });

    it("the foreign-listener check answers true, even for a directory with no listener names", () => {
      const deps = productionDeps({ host, helperSocket: "/nonexistent/helper.sock", boot: makeRig().deps.boot });
      expect(deps.hasForeignListener(scratch())).toBe(true);
    });

    it("a connect is refused and never dials the socket that is there", async () => {
      const deps = productionDeps({ host, helperSocket: "/nonexistent/helper.sock", boot: makeRig().deps.boot });
      const l = await listening();
      try {
        await expect(deps.agentFor(l.dir).ping()).rejects.toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(l.connections()).toBe(0);
      } finally {
        await l.close();
      }
    });
  });

  it.each(noOps.filter(([, host]) => host.euid !== undefined))("a sandbox create answers vsock_dir_refused on %s", async (_name, host) => {
    const rig = makeRig();
    const daemon = createProductionSandboxd({ host, helperSocket: rig.helper.sock, boot: rig.deps.boot, bootTimeoutMs: 3000 });
    await expect(daemon.create(params("noops"))).rejects.toMatchObject({ code: "vsock_dir_refused" });
  });

  it("the daemon is not built at all where the euid is unknown", () => {
    const rig = makeRig();
    expect(() => createProductionSandboxd({ host: { euid: undefined, platform: "linux" }, helperSocket: rig.helper.sock, boot: rig.deps.boot })).toThrow(CliError);
  });

  it("the refusing operations open nothing, inspect nothing and dial nothing", async () => {
    expect(() => REFUSING_OPS.open("/anything", 0)).toThrow();
    expect(() => REFUSING_OPS.fstat(3)).toThrow();
    expect(() => REFUSING_OPS.dial("/anything")).toThrow();
    const l = await listening();
    try {
      await expect(dialVsockDir(l.dir, REFUSING_OPS)).rejects.toBeInstanceOf(VsockRefused);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(l.connections()).toBe(0);
    } finally {
      await l.close();
    }
  });
});

describe("realFdOps", () => {
  it.each(["darwin", "win32", "freebsd", "", "Linux"])("refuses the platform %j", (platform) => {
    expect(() => realFdOps({ euid: euid ?? 1000, platform })).toThrow(VsockRefused);
  });

  it("refuses a missing euid on linux", () => {
    expect(() => realFdOps({ euid: undefined, platform: "linux" })).toThrow(VsockRefused);
  });

  it("builds operations on linux with an euid, and carries that euid", () => {
    expect(realFdOps({ euid: 1234, platform: "linux" }).euid).toBe(1234);
  });
});
