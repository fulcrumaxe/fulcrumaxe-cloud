import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperSilent, createHelperSandboxes } from "../../src/vm/helperSandboxes.js";
import { LAYOUT } from "../../src/vm/installPlan.js";
import { uninstallCommand, type SnapshotFacts, type UninstallHost } from "../../src/vm/uninstall.js";
import type { UninstallRequest } from "../../src/vm/uninstallActions.js";
import { summarizeSnapshots } from "../../scripts/vm-snapshots.mjs";

/** D#587 B-2a-2 PR-5: the two checks before any root step. The helper is a fake, but it is a real server on a real Unix socket speaking the helper's frames. */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
const scratch = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "fx-ug-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

type Mode = "answer" | "silent" | "refuse";
/** The fake helper. `stuck` ids stay listed after a destroy that says ok; `failDestroy` ids answer a refusal. `log` is every verb it received, in order. */
async function fakeHelper(ids: string[], opts: { mode?: Mode; failDestroy?: string[]; stuck?: string[]; rows?: unknown[]; spawnOnDestroy?: string } = {}) {
  const sock = path.join(scratch(), "h.sock");
  const log: string[] = [];
  const live = new Set(ids);
  const server = net.createServer((c) => {
    let buf = "";
    c.on("error", () => undefined);
    c.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const frame = JSON.parse(buf.slice(0, nl)) as { verb: string; sandbox_id?: string };
      log.push(frame.verb === "destroy" ? `destroy ${frame.sandbox_id}` : frame.verb);
      if (opts.mode === "silent") return;
      const reply = (o: object): void => void c.end(`${JSON.stringify({ protocol: 1, ...o })}\n`);
      if (opts.mode === "refuse") return reply({ ok: false, code: "bad_peer" });
      if (frame.verb === "list" && opts.rows !== undefined) return reply({ ok: true, sandboxes: opts.rows });
      if (frame.verb === "list") return reply({ ok: true, sandboxes: [...live].map((sandbox_id) => ({ sandbox_id, vsock_dir: "/fx-test/v", sandbox_gid: 5000 })) });
      if (opts.failDestroy?.includes(frame.sandbox_id ?? "")) return reply({ ok: false, code: "internal" });
      if (!opts.stuck?.includes(frame.sandbox_id ?? "")) live.delete(frame.sandbox_id ?? "");
      if (opts.spawnOnDestroy !== undefined) live.add(opts.spawnOnDestroy);
      reply({ ok: true });
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  cleanups.push(() => server.close());
  return { sock, log };
}

function host(helper: UninstallHost["helper"], snap: SnapshotFacts = { dir: "/fx-test/snaps", summary: { count: 3, bytes: 12345 } }, confirm = true) {
  const rootCalls: UninstallRequest[] = [];
  const asked: string[] = [];
  const h: UninstallHost = {
    facts: async (paths) => ({ runner: { user: "alice", uid: 1000 }, existing: paths }),
    hostRefusal: () => undefined,
    root: { run: async (r) => (rootCalls.push(r), { code: 0, stdout: `${JSON.stringify({ ok: true, done: ["a"], unchanged: [], left: [] })}\n` }) },
    confirm: async (q) => (asked.push(q), confirm),
    helper,
    snapshots: async () => snap,
  };
  return { h, rootCalls, asked };
}
const run = async (args: string[], h: UninstallHost): Promise<{ code: number; text: string }> => {
  let text = "";
  const code = await uninstallCommand(args, h, (l) => (text += `${l}\n`));
  return { code, text };
};

describe("uninstall refuses while a sandbox is alive", () => {
  it("names the count and the ids, asks nothing, destroys nothing and makes no root call", async () => {
    const f = await fakeHelper(["sb-one", "sb-two"]);
    const w = host(createHelperSandboxes(f.sock));
    const r = await run(["--yes"], w.h);
    expect(r.code).toBe(1);
    expect(r.text).toContain("Refused: 2 sandboxes are still alive: sb-one, sb-two.");
    expect(w.rootCalls).toHaveLength(0);
    expect(w.asked).toEqual([]);
    expect(f.log).toEqual(["list"]);
  });

  it("--force destroys each one through the helper, checks each is gone, and only then makes the one root call", async () => {
    const f = await fakeHelper(["sb-one", "sb-two"]);
    const order: string[] = [];
    const real = createHelperSandboxes(f.sock);
    const w = host({ list: real.list, destroy: async (id) => (order.push(`destroy ${id}`), real.destroy(id)) });
    const root = w.h.root.run;
    w.h.root.run = async (r) => (order.push("root"), root(r));
    const r = await run(["--force", "--yes"], w.h);
    expect(r.code).toBe(0);
    expect(order).toEqual(["destroy sb-one", "destroy sb-two", "root"]);
    expect(f.log.filter((v) => v.startsWith("destroy"))).toEqual(["destroy sb-one", "destroy sb-two"]);
    expect(r.text).toContain("Destroyed sandbox sb-one; the helper no longer lists it.");
    expect(w.rootCalls).toHaveLength(1);
    expect(await real.list()).toEqual([]);
  });

  it.each([
    ["the helper refuses the destroy", { failDestroy: ["sb-two"] }],
    ["the helper says ok but still lists it", { stuck: ["sb-two"] }],
  ])("a destroy that fails stops the uninstall with zero root calls: %s", async (_name, opts) => {
    const f = await fakeHelper(["sb-one", "sb-two"], opts);
    const w = host(createHelperSandboxes(f.sock));
    const r = await run(["--force", "--yes"], w.h);
    expect(r.code).toBe(1);
    expect(r.text).toContain("sandbox sb-two could not be destroyed");
    expect(r.text).not.toContain("Uninstalled");
    expect(w.rootCalls).toHaveLength(0);
  });

  it("a sandbox created while the destroys ran stops the uninstall before any root step", async () => {
    const f = await fakeHelper(["sb-one"], { spawnOnDestroy: "sb-late" });
    const w = host(createHelperSandboxes(f.sock));
    const r = await run(["--force", "--yes"], w.h);
    expect(r.code).toBe(1);
    expect(r.text).toContain("still lists sb-late");
    expect(w.rootCalls).toHaveLength(0);
  });

  it("no sandbox alive: goes straight on, with no destroy", async () => {
    const f = await fakeHelper([]);
    const w = host(createHelperSandboxes(f.sock));
    expect((await run(["--yes"], w.h)).code).toBe(0);
    expect(f.log).toEqual(["list"]);
    expect(w.rootCalls).toHaveLength(1);
  });
});

describe("ids the helper sends are checked against its own pattern", () => {
  const rows: Array<[string, unknown]> = [
    ["upper case", { sandbox_id: "SB-One" }],
    ["a path", { sandbox_id: "../x" }],
    ["a space", { sandbox_id: "sb one" }],
    ["41 characters", { sandbox_id: `a${"b".repeat(40)}` }],
    ["a leading dash", { sandbox_id: "-sb" }],
    ["not a string", { sandbox_id: 7 }],
    ["no sandbox_id", { vsock_dir: "/fx-test/v" }],
    ["not an object", "sb-one"],
  ];
  it.each(rows)("a list with a bad id (%s) is refused as no answer: no destroy reaches the helper, no root call", async (_n, bad) => {
    const f = await fakeHelper([], { rows: [{ sandbox_id: "sb-ok" }, bad] });
    for (const args of [["--yes"], ["--force", "--yes"]]) {
      const w = host(createHelperSandboxes(f.sock));
      const r = await run(args, w.h);
      if (args.includes("--force")) expect(r.text).toContain("live VMs may remain");
      else expect(r).toMatchObject({ code: 1, text: expect.stringContaining("Refused: the sandbox helper did not answer") });
      expect(w.rootCalls).toHaveLength(args.includes("--force") ? 1 : 0);
    }
    expect(f.log.filter((v) => v.startsWith("destroy"))).toEqual([]);
  });

  it("destroy refuses a bad id itself, before anything is sent", async () => {
    const f = await fakeHelper(["sb-one"]);
    const c = createHelperSandboxes(f.sock);
    for (const id of ["../x", "SB", "", "a b", `a${"b".repeat(40)}`]) await expect(c.destroy(id)).rejects.toBeInstanceOf(HelperSilent);
    expect(f.log).toEqual([]);
  });
});

describe("uninstall when the helper does not answer", () => {
  const silent = async () => createHelperSandboxes((await fakeHelper(["sb-one"], { mode: "silent" })).sock, 150);
  const refusing = async () => createHelperSandboxes((await fakeHelper(["sb-one"], { mode: "refuse" })).sock);
  const absent = (): ReturnType<typeof createHelperSandboxes> => createHelperSandboxes(path.join(scratch(), "none.sock"));

  it.each([
    ["silent", silent],
    ["refusing", refusing],
    ["absent", async () => absent()],
  ])("%s without --force is refused, with no root call", async (_n, make) => {
    const w = host(await make());
    const r = await run(["--yes"], w.h);
    expect(r.code).toBe(1);
    expect(r.text).toContain("Refused: the sandbox helper did not answer");
    expect(w.rootCalls).toHaveLength(0);
    expect(w.asked).toEqual([]);
  });

  it("--force says live VMs may remain and still waits for the confirmation, even with --yes; a no cancels", async () => {
    const a = host(await silent());
    const ra = await run(["--force", "--yes"], a.h);
    expect(ra.text).toContain("live VMs may remain");
    expect(a.asked).toHaveLength(1);
    expect(ra.code).toBe(0);
    expect(a.rootCalls).toHaveLength(1);
    const b = host(await silent(), undefined, false);
    expect(await run(["--force", "--yes"], b.h)).toMatchObject({ code: 1, text: expect.stringContaining("Cancelled") });
    expect(b.rootCalls).toHaveLength(0);
  });
});

describe("--dry-run with the guards", () => {
  it("destroys nothing and makes no root call, but says what would be destroyed", async () => {
    const f = await fakeHelper(["sb-one"]);
    const w = host(createHelperSandboxes(f.sock));
    const r = await run(["--dry-run", "--force"], w.h);
    expect(r).toMatchObject({ code: 0, text: expect.stringContaining("will destroy 1 live sandbox through the helper first: sb-one") });
    expect(f.log).toEqual(["list"]);
    expect(w.rootCalls).toHaveLength(0);
    expect(w.asked).toEqual([]);
  });

  it("without --force it shows the same refusal the real run would", async () => {
    const f = await fakeHelper(["sb-one"]);
    expect(await run(["--dry-run"], host(createHelperSandboxes(f.sock)).h)).toMatchObject({ code: 1, text: expect.stringContaining("Refused: 1 sandbox is still alive: sb-one.") });
  });
});

describe("what is kept", () => {
  const kept = async (snap: SnapshotFacts): Promise<string> => (await run(["--dry-run"], host({ list: async () => [], destroy: async () => undefined }, snap).h)).text;

  it("prints the directory, the count and the bytes before the confirmation, and that they are kept", async () => {
    const w = host({ list: async () => [], destroy: async () => undefined });
    const r = await run([], w.h);
    expect(r.text).toContain("Kept, not touched: your snapshot_dir /fx-test/snaps holds 3 snapshots, 12345 bytes in all.");
    expect(r.text.indexOf("Kept, not touched")).toBeLessThan(r.text.indexOf("Uninstalled"));
    expect(await kept({ dir: "/fx-test/snaps", summary: { count: 1, bytes: 0 } })).toContain("holds 1 snapshot, 0 bytes in all");
  });

  it("says so, with no numbers, when another path could not be read", async () => {
    const a = await kept({ dir: "/fx-test/snaps", summary: undefined });
    expect(a).toContain("It could not be read, so its snapshots could not be counted.");
    expect(a).not.toMatch(/holds|bytes in all|null|undefined/);
  });

  const RULE = "is root-only: it is removed if it is empty, and if it still holds files it is left in place and listed";

  it("names the only-if-empty rule, and not 'Kept, not touched', when snapshot_dir is the directory install made", async () => {
    for (const dir of [LAYOUT.snapshotDir, `${LAYOUT.snapshotDir}/`, "/var/lib//fx-vm-snapshots"]) {
      const t = await kept({ dir, summary: { count: 4, bytes: 99 } });
      expect(t, dir).toContain(`The snapshot directory ${LAYOUT.snapshotDir} ${RULE}`);
      expect(t, dir).not.toMatch(/Kept, not touched|holds 4|bytes in all/);
    }
  });

  it("names the same rule, and not 'Kept, not touched', when snapshot_dir is not set", async () => {
    const t = await kept({ dir: undefined, summary: undefined });
    expect(t).toContain(`The snapshot directory ${LAYOUT.snapshotDir} ${RULE}`);
    expect(t).not.toMatch(/Kept, not touched|not set in the runner settings|null|undefined/);
  });

  it("keeps 'Kept, not touched' for any other path, including one that only starts like the install's", async () => {
    for (const dir of ["/fx-test/snaps", `${LAYOUT.snapshotDir}-old`, `${LAYOUT.snapshotDir}/sub`, "/var/lib/fx-vm"]) {
      const t = await kept({ dir, summary: { count: 2, bytes: 8 } });
      expect(t, dir).toContain(`Kept, not touched: your snapshot_dir ${dir} holds 2 snapshots, 8 bytes in all.`);
      expect(t, dir).not.toContain(RULE);
    }
  });

  it("the bin-edge reader counts top-level entries and bytes without following links, and gives up on an unreadable directory", () => {
    const d = scratch();
    mkdirSync(path.join(d, "s1"));
    writeFileSync(path.join(d, "s1", "mem"), "x".repeat(100));
    writeFileSync(path.join(d, "s2"), "y".repeat(50));
    symlinkSync(path.join(d, "s1"), path.join(d, "ln"));
    const got = summarizeSnapshots(d) as { count: number; bytes: number };
    expect(got.count).toBe(3);
    expect(got.bytes).toBeGreaterThanOrEqual(150);
    expect(got.bytes).toBeLessThan(150 + 3 * 4096 + 64);
    expect(summarizeSnapshots(path.join(d, "missing"))).toBeUndefined();
    expect(summarizeSnapshots(path.join(d, "s2"))).toBeUndefined();
  });

  it("the entry cap applies while reading: over it, no number at all; at it, the number", () => {
    const d = scratch();
    for (let i = 0; i < 5; i++) writeFileSync(path.join(d, `f${i}`), "");
    mkdirSync(path.join(d, "sub"));
    writeFileSync(path.join(d, "sub", "deep"), "");
    expect(summarizeSnapshots(d, 7)).toMatchObject({ count: 6 });
    expect(summarizeSnapshots(d, 6)).toBeUndefined();
  });

  it("a symlink loop is one entry and is never followed", () => {
    const d = scratch();
    mkdirSync(path.join(d, "a"));
    symlinkSync(d, path.join(d, "a", "up"));
    symlinkSync(path.join(d, "self"), path.join(d, "self"));
    expect(summarizeSnapshots(d)).toMatchObject({ count: 2 });
  });
});
