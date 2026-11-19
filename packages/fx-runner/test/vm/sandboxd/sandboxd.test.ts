import { chmodSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../../../src/cliError.js";
import { SandboxdError, Sandboxd, assertNotRoot, checkVsockDir } from "../../../src/vm/sandboxd/sandboxd.js";
import { listing, makeRig, runCleanups } from "./helpers.js";

afterEach(runCleanups);
const params = (name: string) => ({ name, template: "fx-agent", vcpus: 2, memMb: 512 });
const verbs = (rig: ReturnType<typeof makeRig>): unknown[] => rig.helper.frames.map((f) => f["verb"]);

describe("create, get, stop, resume, delete", () => {
  it("creates a named sandbox through prepare then start, and get finds it again", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(params("alpha"));
    expect(sb.status).toBe("running");
    expect(verbs(rig)).toEqual(["prepare", "start"]);
    expect(rig.helper.frames[0]).toEqual({ verb: "prepare", sandbox_id: "alpha", template: "fx-agent", vcpus: 2, mem_mb: 512 });
    expect((await rig.daemon.get("alpha")).name).toBe("alpha");
    expect(rig.daemon.registered.has("alpha")).toBe(true);
  });

  it("a taken name answers the overlay's 400 bad_request, and a bad name never reaches the helper", async () => {
    const rig = makeRig();
    await rig.daemon.create(params("alpha"));
    const taken = await rig.daemon.create(params("alpha")).catch((e: unknown) => e);
    expect(taken).toMatchObject({ status: 400, code: "bad_request" });
    for (const bad of ["", "-x", "UP", "a/b", "a".repeat(41), "..", "x y"]) await expect(rig.daemon.create(params(bad))).rejects.toMatchObject({ status: 400, code: "bad_request" });
    expect(rig.helper.frames.filter((f) => f["sandbox_id"] !== "alpha")).toEqual([]);
  });

  it("two creates of one name in the same turn: one wins, the other is the 400", async () => {
    const rig = makeRig();
    const results = await Promise.allSettled([rig.daemon.create(params("dup")), rig.daemon.create(params("dup"))]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(verbs(rig)).toEqual(["prepare", "start"]);
  });

  it("get of an unknown name is 404 not_found", async () => {
    await expect(makeRig().daemon.get("nope")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("stop destroys the VM and keeps the name; resume boots it again; delete frees the name", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(params("alpha"));
    await sb.stop();
    expect(sb.status).toBe("stopped");
    expect(verbs(rig)).toEqual(["prepare", "start", "destroy"]);
    expect(rig.daemon.registered.has("alpha")).toBe(false);
    await expect(sb.runCommand({ cmd: "true" })).rejects.toMatchObject({ status: 409, code: "not_running" });
    await expect(rig.daemon.create(params("alpha"))).rejects.toMatchObject({ code: "bad_request" });
    await rig.daemon.get("alpha", { resume: true });
    expect(sb.status).toBe("running");
    await sb.delete();
    expect(rig.daemon.list()).toEqual([]);
    await rig.daemon.delete("alpha"); // idempotent
    await rig.daemon.create(params("alpha"));
  });

  it("a start that fails destroys the half-made VM and gives the name back", async () => {
    const rig = makeRig();
    rig.helper.refuse.set("start", "unavailable");
    await expect(rig.daemon.create(params("alpha"))).rejects.toMatchObject({ status: 502, code: "helper_failed" });
    expect(verbs(rig)).toEqual(["prepare", "start", "destroy"]);
    expect(rig.daemon.list()).toEqual([]);
    expect(rig.daemon.registered.size).toBe(0);
    rig.helper.refuse.clear();
    await rig.daemon.create(params("alpha"));
  });

  it("a destroy the helper refuses leaves the id registered, so the teardown still sees it", async () => {
    const rig = makeRig();
    const sb = await rig.daemon.create(params("alpha"));
    rig.helper.refuse.set("destroy", "internal");
    await expect(sb.stop()).rejects.toMatchObject({ code: "helper_failed" });
    expect(rig.daemon.registered.has("alpha")).toBe(true);
    expect(sb.status).toBe("running");
  });
});

describe("the boot gate is first", () => {
  it("an unlisted digest, an unverified listing: the helper receives no frame at all", async () => {
    const unlisted = makeRig({ listing: listing({ kernel: "f".repeat(64) }) });
    await expect(unlisted.daemon.create(params("alpha"))).rejects.toBeInstanceOf(CliError);
    expect(unlisted.helper.frames).toEqual([]);
    expect(unlisted.daemon.list()).toEqual([]);
    const expired = makeRig({ listing: { ok: false, state: "expired" } as never });
    await expect(expired.daemon.create(params("alpha"))).rejects.toThrow(/could not be verified/);
    expect(expired.helper.frames).toEqual([]);
  });

  it("a template the helper does not know comes back as a fixed helper_failed", async () => {
    const rig = makeRig();
    rig.helper.refuse.set("prepare", "unknown_template");
    const err = await rig.daemon.create(params("alpha")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxdError);
    expect((err as Error).message).toBe("fx-sandboxd: helper_failed");
  });
});

describe("the daemon is not root", () => {
  it("this process runs with euid != 0, and the daemon refuses a root or unknown euid", () => {
    expect(process.geteuid?.()).not.toBe(0);
    expect(() => assertNotRoot(0)).toThrow(/not as root/);
    expect(() => assertNotRoot(undefined)).toThrow(CliError);
    expect(() => assertNotRoot(-1)).toThrow(CliError);
    expect(() => assertNotRoot(1.5)).toThrow(CliError);
    expect(() => assertNotRoot(1000)).not.toThrow();
    const rig = makeRig();
    expect(() => new Sandboxd({ ...rig.deps, euid: 0 })).toThrow(/not as root/);
  });
});

describe("the vsock directory the helper names is checked again", () => {
  const facts = { isDirectory: true, isSymbolicLink: false, uid: 1000, gid: 2000, mode: 0o41770 };
  const ok = (dir = "/j/vsock/a", f = facts, gid = 2000) => checkVsockDir(dir, "a", gid, 1000, f);
  it("accepts exactly the shape the helper builds: 01770 (runner owner, sandbox group, sticky)", () => expect(ok()).toBe("/j/vsock/a"));
  it.each([
    ["relative", () => ok("j/vsock/a")],
    ["dot-dot", () => ok("/j/../vsock/a")],
    ["NUL", () => ok("/j/vsock/a\0")],
    ["another sandbox's name", () => ok("/j/vsock/b")],
    ["trailing slash", () => ok("/j/vsock/a/")],
    ["not there", () => checkVsockDir("/j/vsock/a", "a", 2000, 1000, undefined)],
    ["a symlink", () => ok("/j/vsock/a", { ...facts, isSymbolicLink: true })],
    ["not a directory", () => ok("/j/vsock/a", { ...facts, isDirectory: false })],
    ["another owner", () => ok("/j/vsock/a", { ...facts, uid: 0 })],
    ["another group", () => ok("/j/vsock/a", facts, 2001)],
    ["mode 0710 (the superseded one)", () => ok("/j/vsock/a", { ...facts, mode: 0o40710 })],
    ["mode 0770 without the sticky bit", () => ok("/j/vsock/a", { ...facts, mode: 0o40770 })],
    ["mode 01777", () => ok("/j/vsock/a", { ...facts, mode: 0o41777 })],
    ["mode 0750", () => ok("/j/vsock/a", { ...facts, mode: 0o40750 })],
    ["mode 0711", () => ok("/j/vsock/a", { ...facts, mode: 0o40711 })],
  ])("refuses %s", (_label, run) => expect(run).toThrow(SandboxdError));

  it("create refuses a directory the helper swapped for a symlink, a wrong mode or a wrong name, and destroys the VM", async () => {
    for (const how of ["symlink", "mode", "name"] as const) {
      const rig = makeRig();
      rig.helper.mangle = (id, dir) => {
        if (how === "mode") chmodSync(dir, 0o770);
        if (how === "name") return path.join(path.dirname(dir), "other");
        if (how === "symlink") {
          const parent = path.join(path.dirname(path.dirname(dir)), "linkdir");
          mkdirSync(parent, { recursive: true });
          if (!existsSync(path.join(parent, id))) symlinkSync(dir, path.join(parent, id));
          return path.join(parent, id);
        }
        return dir;
      };
      await expect(rig.daemon.create(params("alpha")), how).rejects.toMatchObject({ code: "vsock_dir_refused" });
      expect(verbs(rig), how).toEqual(["prepare", "start", "destroy"]);
    }
  });
});

describe("list never waits on prepare", () => {
  it("while a prepare is held open, list answers at once with the sandbox as creating", async () => {
    const rig = makeRig();
    let release!: () => void;
    rig.helper.holdPrepare = new Promise<void>((r) => (release = r));
    const creating = rig.daemon.create(params("slow"));
    await new Promise((r) => setTimeout(r, 50)); // the prepare frame is at the helper and unanswered
    expect(rig.helper.frames.map((f) => f["verb"])).toEqual(["prepare"]);
    const before = Date.now();
    expect(rig.daemon.list()).toEqual([{ name: "slow", state: "creating", createdAt: 1_700_000_000 }]);
    expect(Date.now() - before).toBeLessThan(50);
    await new Promise((r) => setTimeout(r, 100)); // a list frame would have arrived by now
    expect(rig.helper.frames.map((f) => f["verb"])).toEqual(["prepare"]); // list asked the helper nothing
    release();
    await creating;
    expect(rig.daemon.list()[0]?.state).toBe("running");
  });
});

describe("stop leaves no timer pending", () => {
  it("the start-wait and settle timers that race the commands are cleared once the race is decided", async () => {
    const rig = makeRig({ extra: { startWaitMs: 31_000, pollMs: 7_001 } });
    const sb = await rig.daemon.create(params("alpha"));
    const cmd = await sb.runCommand({ cmd: "sleep", args: ["31.2"] });
    const made = new Map<unknown, number>();
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const handle = realSet(fn, ms);
      if (ms === 31_000 || ms === 7_001) made.set(handle, ms);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(handle);
      return realClear(handle);
    }) as typeof clearTimeout;
    try {
      await sb.stop();
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
    await cmd.wait().catch(() => undefined);
    expect(made.size).toBeGreaterThanOrEqual(2); // both races armed a timer
    expect([...made.keys()].filter((h) => !cleared.has(h))).toEqual([]);
  });
});
