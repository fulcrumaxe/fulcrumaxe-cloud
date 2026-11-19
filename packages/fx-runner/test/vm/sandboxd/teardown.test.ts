import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../../../src/cliError.js";
import { createGuestAgent, viaFirecrackerVsock } from "../../../src/vm/sandboxd/guestAgent.js";
import { createProductionSandboxd } from "../../../src/vm/sandboxd/production.js";
import { fdInspectDir } from "../../../src/vm/sandboxd/vsockFd.js";
import { TeardownError, globalTeardown, type ProcessLister } from "../../../src/vm/sandboxd/teardown.js";
import { HOST, makeRig, makePgrepLister, pgrepLister, realOps, runCleanups, scratch, startSilentProxy, trackTimers } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  runCleanups();
});
const params = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512 });
const lister = (counts: number[]): ProcessLister & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, count: async (name) => (asked.push(name), counts.shift() ?? 0) };
};
const timed = async <T>(p: Promise<T>): Promise<{ value?: T; err?: unknown; ms: number }> => {
  const t = Date.now();
  const out = await p.then((value) => ({ value }), (err: unknown) => ({ err }));
  return { ...out, ms: Date.now() - t };
};
const destroys = (rig: ReturnType<typeof makeRig>): string[] => rig.helper.frames.filter((f) => f["verb"] === "destroy").map((f) => String(f["sandbox_id"]));

describe("global teardown", () => {
  it("stops and destroys every registered sandbox (running, with a command, stopped), then counts firecracker at 0", async () => {
    const rig = makeRig();
    const a = await rig.daemon.create(params("a"));
    await rig.daemon.create(params("b"));
    const c = await rig.daemon.create(params("c"));
    const cmd = await a.runCommand({ cmd: "sleep", args: ["31.4"] });
    await c.stop();
    expect([...rig.daemon.registered].sort()).toEqual(["a", "b"]);
    const procs = lister([0]);
    const report = await globalTeardown(rig.daemon, procs);
    expect(report).toEqual({ destroyed: ["a", "b"], processes: 0 });
    expect(procs.asked).toEqual(["firecracker"]);
    expect([...rig.daemon.registered]).toEqual([]);
    expect(rig.helper.entries.size).toBe(0);
    expect(rig.daemon.list().map((r) => r.name)).toEqual(["c"]); // the stopped sandbox was not registered with the helper: its record is not teardown's to drop
    await cmd.wait().catch(() => undefined);
  });

  it("the per-sandbox bound's timer is cleared once each sandbox is done, whether it finished or its teardown failed", async () => {
    const rig = makeRig();
    await rig.daemon.create(params("a"));
    await rig.daemon.create(params("b"));
    rig.helper.refuse.set("destroy", "unknown_sandbox_not_really"); // b's and a's destroy are both refused by a code the daemon does not treat as gone
    const refused = await trackTimers([61_003], () => globalTeardown(rig.daemon, lister([0]), { perSandboxMs: 61_003 }).catch(() => undefined));
    expect(refused.made).toBe(2);
    expect(refused.uncleared).toBe(0);
    rig.helper.refuse.delete("destroy");
    const done = await trackTimers([61_003], () => globalTeardown(rig.daemon, lister([0]), { perSandboxMs: 61_003 }));
    expect(done.made).toBe(2);
    expect(done.uncleared).toBe(0);
  });

  it("an id whose create failed and whose destroy was refused is still in `registered`, and teardown finishes it", async () => {
    const rig = makeRig();
    rig.helper.refuse.set("start", "internal");
    rig.helper.refuse.set("destroy", "internal");
    await expect(rig.daemon.create(params("x"))).rejects.toMatchObject({ code: "helper_failed" });
    expect([...rig.daemon.registered]).toEqual(["x"]);
    rig.helper.refuse.clear();
    await globalTeardown(rig.daemon, lister([0]));
    expect([...rig.daemon.registered]).toEqual([]);
    expect(destroys(rig).at(-1)).toBe("x");
    expect(rig.helper.entries.size).toBe(0);
  });

  it("fails loudly when a firecracker process is left, or a destroy is refused, or the count cannot be taken", async () => {
    const rig = makeRig();
    await rig.daemon.create(params("a"));
    const left = await timed(globalTeardown(rig.daemon, lister([3])));
    expect(left.err).toBeInstanceOf(TeardownError);
    expect(left.err).toMatchObject({ leftover: [], processes: 3 });

    const rig2 = makeRig();
    await rig2.daemon.create(params("b"));
    rig2.helper.refuse.set("destroy", "internal");
    const refused = await timed(globalTeardown(rig2.daemon, lister([0])));
    expect(refused.err).toMatchObject({ leftover: ["b"], processes: 0 });

    const broken = await timed(globalTeardown(makeRig().daemon, { count: () => Promise.reject(new TeardownError([], -1)) }));
    expect(broken.err).toBeInstanceOf(TeardownError);
  });

  it("is bounded: a destroy that never answers, and a command stuck on a silent guest, do not hang it", async () => {
    const proxy = startSilentProxy();
    const silent = createGuestAgent(viaFirecrackerVsock(proxy, 5252, 60_000), 60_000);
    const rig = makeRig({ extra: { startWaitMs: 300 } });
    const sb = await rig.daemon.create(params("a"));
    (rig.daemon as unknown as { records: Map<string, { agent: unknown }> }).records.get("a")!.agent = silent;
    void sb.runCommand({ cmd: "sleep", args: ["31.6"] }).catch(() => undefined);
    const stuck = await timed(globalTeardown(rig.daemon, lister([0]), { perSandboxMs: 5000 }));
    expect(stuck.err).toBeUndefined();
    expect(stuck.ms).toBeLessThan(4000);
    expect(destroys(rig)).toEqual(["a"]);

    const rig2 = makeRig();
    await rig2.daemon.create(params("b"));
    rig2.deps.helper = { ...rig2.deps.helper, destroy: () => new Promise<void>(() => undefined) };
    const hung = await timed(globalTeardown(rig2.daemon, lister([0]), { perSandboxMs: 200 }));
    expect(hung.err).toMatchObject({ leftover: ["b"] });
    expect(hung.ms).toBeLessThan(3000);
  });

  it("waits for a sandbox that is still being created, then destroys it: a destroy sent before `prepare` landed would be told unknown and leave the VM", async () => {
    const rig = makeRig();
    let release!: () => void;
    rig.helper.holdPrepare = new Promise<void>((r) => (release = r));
    const creating = rig.daemon.create(params("slow"));
    creating.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const ending = globalTeardown(rig.daemon, lister([0]));
    await new Promise((r) => setTimeout(r, 100));
    expect(destroys(rig)).toEqual([]); // not yet: the boot is still in flight
    release();
    await ending;
    await creating;
    expect([...rig.daemon.registered]).toEqual([]);
    expect(rig.helper.entries.size).toBe(0);
    expect(destroys(rig)).toEqual(["slow"]);
  });

  it("a create that never lands is given up on at the per-sandbox bound, and reported", async () => {
    const rig = makeRig();
    rig.helper.holdPrepare = new Promise<void>(() => undefined);
    void rig.daemon.create(params("stuck")).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const out = await timed(globalTeardown(rig.daemon, lister([0]), { perSandboxMs: 300 }));
    expect(out.err).toMatchObject({ leftover: ["stuck"] });
    expect(out.ms).toBeLessThan(3000);
  });
});

describe("the real pgrep adapter", () => {
  it("counts 0 for a name nothing runs under, and counts a live process by name", async () => {
    expect(await pgrepLister.count("fx-no-such-process-name")).toBe(0);
    const child = spawn("sleep", ["31.77"], { stdio: "ignore", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await pgrepLister.count("sleep")).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("the pgrep adapter fails closed", () => {
  const script = (body: string): string => {
    const file = path.join(scratch(), "fake-pgrep");
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  it("a missing binary, a crash with output, and a non-numeric answer are failures, never a count of 0", async () => {
    for (const bin of ["/nonexistent/pgrep", script("echo 0; exit 2"), script("echo 3x; exit 0"), script("exit 0")]) await expect(makePgrepLister(bin).count("firecracker")).rejects.toBeInstanceOf(TeardownError);
  });
  it("exit 1 with a 0 is none, and a count is the count", async () => {
    expect(await makePgrepLister(script("echo 0; exit 1")).count("firecracker")).toBe(0);
    expect(await makePgrepLister(script("echo 4; exit 0")).count("firecracker")).toBe(4);
  });
});

describe("production wiring", () => {
  it("fdInspectDir reports what an O_PATH|O_NOFOLLOW fd shows: a directory, a symlink as a symlink, nothing for a missing path", () => {
    const root = scratch();
    mkdirSync(path.join(root, "d"), { mode: 0o710 });
    symlinkSync(path.join(root, "d"), path.join(root, "link"));
    expect(fdInspectDir(path.join(root, "d"), realOps())).toMatchObject({ isDirectory: true, isSymbolicLink: false, uid: process.getuid?.(), gid: process.getgid?.() });
    expect(fdInspectDir(path.join(root, "link"), realOps())).toMatchObject({ isDirectory: false, isSymbolicLink: true });
    expect(fdInspectDir(path.join(root, "missing"), realOps())).toBeUndefined();
    expect(fdInspectDir(path.join(root, "link", "x"), realOps())).toBeUndefined();
  });

  it("the production daemon creates a sandbox and moves a file through the real socket, lstat and vsock adapters", async () => {
    const rig = makeRig();
    const daemon = createProductionSandboxd({ host: HOST, helperSocket: rig.helper.sock, boot: rig.deps.boot, bootTimeoutMs: 3000 });
    const sb = await daemon.create(params("prod"));
    expect(Math.abs(daemon.list()[0]!.createdAt - Date.now() / 1000)).toBeLessThan(60); // Unix seconds, as the helper's own `created` is
    await sb.writeFiles([{ path: "/work/x", content: Buffer.from("through production") }]);
    const parts: Buffer[] = [];
    await sb.readFile("/work/x", (c) => void parts.push(c));
    expect(Buffer.concat(parts).toString()).toBe("through production");
    await globalTeardown(daemon, lister([0]));
    expect(rig.helper.entries.size).toBe(0);
  });

  it("refuses to be built as root", () => {
    const rig = makeRig();
    expect(() => createProductionSandboxd({ host: { ...HOST, euid: 0 }, helperSocket: rig.helper.sock, boot: rig.deps.boot })).toThrow(CliError);
  });

  it("the production daemon refuses a vsock directory that is a symlink (the lstat adapter feeds the check)", async () => {
    const rig = makeRig();
    const elsewhere = scratch();
    rig.helper.mangle = (id, dir) => {
      const link = path.join(elsewhere, id); // the right basename, but a symlink to the real directory
      if (!existsSync(link)) symlinkSync(dir, link);
      return link;
    };
    const daemon = createProductionSandboxd({ host: HOST, helperSocket: rig.helper.sock, boot: rig.deps.boot });
    await expect(daemon.create(params("sym"))).rejects.toMatchObject({ code: "vsock_dir_refused" });
    await globalTeardown(daemon, lister([0]));
  });
});
