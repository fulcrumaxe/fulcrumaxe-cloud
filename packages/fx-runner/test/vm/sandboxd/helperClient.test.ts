import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HELPER_CODES, HelperError, createHelperClient } from "../../../src/vm/sandboxd/helperClient.js";
import { connectUnix, runCleanups, scratch, startFakeHelper } from "./helpers.js";

afterEach(runCleanups);

describe("the helper client speaks the helper's frames", () => {
  it("prepare, start, list and destroy send exactly the typed frames and read the reply fields", async () => {
    const root = scratch();
    const h = startFakeHelper(root, 4242);
    const client = createHelperClient(connectUnix(h.sock), 3000);
    const p = await client.prepare({ sandboxId: "box-1", template: "fx-agent", vcpus: 2, memMb: 256 });
    expect(p).toEqual({ vsockDir: path.join(root, "vsock", "box-1"), sandboxGid: 4242 });
    expect(await client.start("box-1")).toEqual(p);
    expect(await client.list()).toEqual([{ sandboxId: "box-1", vsockDir: p.vsockDir, sandboxGid: 4242, created: 1_700_000_000 }]);
    await client.destroy("box-1");
    expect(h.frames).toEqual([
      { verb: "prepare", sandbox_id: "box-1", template: "fx-agent", vcpus: 2, mem_mb: 256 },
      { verb: "start", sandbox_id: "box-1" },
      { verb: "list" },
      { verb: "destroy", sandbox_id: "box-1" },
    ]);
  });

  it.each(HELPER_CODES)("a refusal %s is a HelperError carrying that code and nothing else", async (code) => {
    const h = startFakeHelper(scratch());
    h.refuse.set("start", code);
    const err = await createHelperClient(connectUnix(h.sock), 3000).start("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect((err as HelperError).code).toBe(code);
    expect((err as Error).message).toBe(`the sandbox helper answered: ${code}`);
  });

  it.each([
    ["a code outside the closed list", '{"ok":false,"protocol":1,"code":"/etc/shadow leaked"}'],
    ["a protocol it does not speak", '{"ok":true,"protocol":2,"vsock_dir":"/a/b","sandbox_gid":5}'],
    ["not JSON", "root:x:0:0"],
    ["an array", "[]"],
    ["no ok", '{"protocol":1}'],
    ["a prepare reply without the directory", '{"ok":true,"protocol":1,"sandbox_gid":5}'],
    ["a gid of 0", '{"ok":true,"protocol":1,"vsock_dir":"/a/b","sandbox_gid":0}'],
    ["a negative gid", '{"ok":true,"protocol":1,"vsock_dir":"/a/b","sandbox_gid":-4}'],
    ["a gid that is a string", '{"ok":true,"protocol":1,"vsock_dir":"/a/b","sandbox_gid":"5"}'],
    ["a directory that is a number", '{"ok":true,"protocol":1,"vsock_dir":7,"sandbox_gid":5}'],
  ])("%s is bad_reply, and no helper bytes reach the message", async (_label, reply) => {
    const h = startFakeHelper(scratch());
    h.raw.set("start", `${reply}\n`);
    const err = (await createHelperClient(connectUnix(h.sock), 3000).start("x").catch((e: unknown) => e)) as HelperError;
    expect(err.code).toBe("bad_reply");
    expect(err.message).not.toMatch(/shadow|root:x/);
  });

  it("a list entry with a bad id, a bad creation time or no directory is refused whole", async () => {
    for (const row of [{ sandbox_id: "../x", vsock_dir: "/a/x", sandbox_gid: 5 }, { sandbox_id: "x", vsock_dir: "/a/x", sandbox_gid: 5, created: -1 }, { sandbox_id: "x", sandbox_gid: 5 }]) {
      const h = startFakeHelper(scratch());
      h.raw.set("list", `${JSON.stringify({ ok: true, protocol: 1, sandboxes: [row] })}\n`);
      await expect(createHelperClient(connectUnix(h.sock), 3000).list()).rejects.toMatchObject({ code: "bad_reply" });
    }
    const empty = startFakeHelper(scratch());
    expect(await createHelperClient(connectUnix(empty.sock), 3000).list()).toEqual([]);
  });

  it("no helper there is unreachable; a helper that never answers is a timeout; one that hangs up is bad_reply", async () => {
    const dir = scratch();
    await expect(createHelperClient(connectUnix(path.join(dir, "nope.sock")), 500).list()).rejects.toMatchObject({ code: "unreachable" });
    const mute = net.createServer(() => undefined).listen(path.join(dir, "mute.sock"));
    const hangup = net.createServer((s) => s.end()).listen(path.join(dir, "hup.sock"));
    try {
      await expect(createHelperClient(connectUnix(path.join(dir, "mute.sock")), 150).list()).rejects.toMatchObject({ code: "timeout" });
      await expect(createHelperClient(connectUnix(path.join(dir, "hup.sock")), 500).list()).rejects.toMatchObject({ code: "bad_reply" });
    } finally {
      mute.close();
      hangup.close();
    }
  });

  it("a reply over a mebibyte is refused even when its newline is in the same chunk", async () => {
    const dir = scratch();
    const big = net.createServer((s) => {
      s.on("error", () => undefined);
      s.on("data", () => s.write(Buffer.concat([Buffer.from('{"ok":true,"protocol":1,"sandboxes":[]}'), Buffer.alloc((1 << 20) + 10, 0x20), Buffer.from("\n")])));
    }).listen(path.join(dir, "b.sock"));
    try {
      await expect(createHelperClient(connectUnix(path.join(dir, "b.sock")), 2000).list()).rejects.toMatchObject({ code: "bad_reply" });
    } finally {
      big.close();
    }
  });

  it("a reply of over a mebibyte without a newline is refused", async () => {
    const dir = scratch();
    const flood = net.createServer((s) => {
      s.on("error", () => undefined);
      s.on("data", () => s.write(Buffer.alloc((1 << 20) + 10, 0x61)));
    }).listen(path.join(dir, "f.sock"));
    try {
      await expect(createHelperClient(connectUnix(path.join(dir, "f.sock")), 2000).list()).rejects.toMatchObject({ code: "bad_reply" });
    } finally {
      flood.close();
    }
  });
});
